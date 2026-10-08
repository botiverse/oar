import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { prepareOpenCodePrompts, validateOpenCodePrompts, verifyOpenCodeAgent } from "../../packages/oar/src/runtimes/opencode/prompt-config.js";
import type { ExecutableRunner } from "../../packages/oar/src/shared/executable/run.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
  vi.unstubAllEnvs();
});
const json = (value: unknown) => ({ ok: true, stdout: JSON.stringify(value), stderr: "", exitCode: null });

test("override queries native config in the requested cwd and touches only the selected agent's prompt", async () => {
  const run = vi.fn<ExecutableRunner>().mockResolvedValue(json({ default_agent: "scribe", agent: { scribe: { permission: { edit: "deny" }, model: "kept" }, build: { prompt: "kept" } }, instructions: ["kept.md"] }));
  const prepared = await prepareOpenCodePrompts("opencode", { cwd: "/project", systemPrompt: "literal {env:SECRET} and {file:secret.txt}", env: { PROBE_ENV: "yes" } }, run);
  cleanups.push(prepared.cleanup);
  expect(run.mock.calls[0]?.slice(0, 2)).toEqual(["opencode", ["debug", "config"]]);
  expect(run.mock.calls[0]?.[2]).toMatchObject({ cwd: "/project", env: { PROBE_ENV: "yes" }, timeoutMs: 30_000 });
  const content = prepared.options.env?.OPENCODE_CONFIG_CONTENT ?? "";
  expect(content).not.toContain("{env:");
  expect(content).not.toContain("{file:");
  expect(JSON.parse(content)).toEqual({ agent: { scribe: { prompt: "literal {env:SECRET} and {file:secret.txt}" } } });
  expect(prepared.agent).toBe("scribe");
});

test.each([
  { exported: { info: { agent: "saved" }, messages: [] }, expected: "saved" },
  { exported: { info: {}, messages: [{ info: { role: "user", agent: "history", model: { providerID: "p", modelID: "m" } } }] }, expected: "history" },
  { exported: { info: {}, messages: [] }, expected: "current" },
])("resume uses saved agent before the current default: $expected", async ({ exported, expected }) => {
  const run = vi.fn<ExecutableRunner>().mockResolvedValueOnce(json({ default_agent: "current", agent: { current: {}, saved: {}, history: {} } })).mockResolvedValueOnce(json(exported));
  const prepared = await prepareOpenCodePrompts("opencode", { cwd: "/project", resume: "ses_saved", systemPrompt: "replacement" }, run);
  cleanups.push(prepared.cleanup);
  expect(prepared.agent).toBe(expected);
  expect(run.mock.calls[1]?.[1]).toEqual(["export", "ses_saved", "--sanitize"]);
});

// oxlint-disable-next-line max-statements -- One file lifecycle from creation through idempotent removal.
test("append creates a private session file without querying agents; cleanup is idempotent", async () => {
  const run = vi.fn<ExecutableRunner>();
  const text = " appended {env:SECRET} \n";
  const prepared = await prepareOpenCodePrompts("opencode", { cwd: "/project", appendSystemPrompt: text }, run);
  cleanups.push(prepared.cleanup);
  expect(run).not.toHaveBeenCalled();
  const overlay = asRecord(JSON.parse(prepared.options.env?.OPENCODE_CONFIG_CONTENT ?? ""));
  const instructions = overlay?.instructions;
  assert.ok(Array.isArray(instructions));
  const file: unknown = instructions[0];
  assert.ok(typeof file === "string");
  expect(await readFile(file, "utf8")).toBe(text);
  expect(Object.keys(overlay ?? {})).toEqual(["instructions"]);
  await Promise.all([prepared.cleanup(), prepared.cleanup()]);
  await expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["systemPrompt", "appendSystemPrompt"] as const)("existing inline config refuses %s before queries", async (option) => {
  const run = vi.fn<ExecutableRunner>();
  const given = { cwd: "/project", [option]: "text" };
  await expect(prepareOpenCodePrompts("opencode", { ...given, env: { OPENCODE_CONFIG_CONTENT: "{}" } }, run)).rejects.toMatchObject({ name: "UnsupportedOptionError", option });
  vi.stubEnv("OPENCODE_CONFIG_CONTENT", "");
  await expect(prepareOpenCodePrompts("opencode", given, run)).rejects.toMatchObject({ name: "UnsupportedOptionError", option });
  expect(run).not.toHaveBeenCalled();
  expect(() => { validateOpenCodePrompts({ cwd: "/project" }); }).not.toThrow();
});

test("empty replacement cannot silently select built-in instructions", () => {
  expect(() => { validateOpenCodePrompts({ cwd: "/", systemPrompt: "" }); }).toThrow("cannot replace the system prompt with an empty string");
});

test("mode read-back rejects a different or missing agent, naming both sides", () => {
  expect(() => { verifyOpenCodeAgent({ configOptions: [{ category: "mode", currentValue: "scribe" }] }, "scribe"); }).not.toThrow();
  expect(() => { verifyOpenCodeAgent({ configOptions: [{ category: "mode", currentValue: "plan" }] }, "scribe"); }).toThrow('selected agent "plan", but the system prompt was configured for "scribe"');
  expect(() => { verifyOpenCodeAgent({}, "scribe"); }).toThrow('selected agent <unreported>, but the system prompt was configured for "scribe"');
});

test("bad query output fails without copying config or transcript contents into the error", async () => {
  const run = vi.fn<ExecutableRunner>().mockResolvedValue({ ok: true, stdout: "private malformed content", stderr: "", exitCode: null });
  await expect(prepareOpenCodePrompts("opencode", { cwd: "/", systemPrompt: "base" }, run)).rejects.toThrow("opencode debug returned invalid JSON while resolving the session's agent");
});

test("a removed saved agent is never recreated by the prompt overlay", async () => {
  const run = vi.fn<ExecutableRunner>().mockResolvedValueOnce(json({ default_agent: "build", agent: {} })).mockResolvedValueOnce(json({ info: { agent: "removed" } }));
  await expect(prepareOpenCodePrompts("opencode", { cwd: "/", resume: "ses_saved", systemPrompt: "base" }, run)).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "systemPrompt" });
});

// oxlint-disable-next-line max-statements -- One prepare/resume operation verifies both native queries and the final overlay.
test("removing inherited inline config permits prompt injection and removes it from every helper query", async () => {
  vi.stubEnv("OPENCODE_CONFIG_CONTENT", "inherited-private-config");
  vi.stubEnv("OAR_ENV_REMOVE", "inherited-private-value");
  const run = vi.fn<ExecutableRunner>().mockResolvedValueOnce(json({})).mockResolvedValueOnce(json({ info: { agent: "build" } }));
  const prepared = await prepareOpenCodePrompts("opencode", {
    cwd: "/project", resume: "old", systemPrompt: "replacement",
    env: { OPENCODE_CONFIG_CONTENT: null, OAR_ENV_REMOVE: null, OAR_ENV_OVERRIDE: "new" },
  }, run);
  cleanups.push(prepared.cleanup);
  expect(run).toHaveBeenCalledTimes(2);
  for (const call of run.mock.calls) {
    const { 2: options } = call;
    expect(options?.env).not.toHaveProperty("OPENCODE_CONFIG_CONTENT");
    expect(options?.env).not.toHaveProperty("OAR_ENV_REMOVE");
    expect(options?.env?.OAR_ENV_OVERRIDE).toBe("new");
  }
  expect(prepared.options.env?.OAR_ENV_REMOVE).toBeNull();
  expect(JSON.parse(prepared.options.env?.OPENCODE_CONFIG_CONTENT ?? "")).toEqual({ agent: { build: { prompt: "replacement" } } });
  expect(process.env.OPENCODE_CONFIG_CONTENT).toBe("inherited-private-config");
});
