import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { prepareOpenCodePrompts, validateOpenCodePrompts, verifyOpenCodeAgent } from "../../packages/oar/src/runtimes/opencode/prompt-config.js";
import { prepareOpenCodeV2Prompts, verifyOpenCodeAgents } from "../../packages/oar/src/runtimes/opencode/prompt-config-v2.js";
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

test.each(["systemPrompt", "appendSystemPrompt"] as const)("malformed inline config refuses %s before queries", async (option) => {
  const run = vi.fn<ExecutableRunner>();
  const given = { cwd: "/project", [option]: "text" };
  await expect(prepareOpenCodePrompts("opencode", { ...given, env: { OPENCODE_CONFIG_CONTENT: "{" } }, run)).rejects.toMatchObject({ name: "UnsupportedOptionError", option });
  vi.stubEnv("OPENCODE_CONFIG_CONTENT", "");
  await expect(prepareOpenCodePrompts("opencode", given, run)).rejects.toMatchObject({ name: "UnsupportedOptionError", option });
  expect(run).not.toHaveBeenCalled();
  expect(() => { validateOpenCodePrompts({ cwd: "/project" }); }).not.toThrow();
});

test("empty replacement cannot silently select built-in instructions", () => {
  expect(() => { validateOpenCodePrompts({ cwd: "/", systemPrompt: "" }); }).toThrow("cannot replace the system prompt with an empty string");
});

test.each(["", "   ", "-c", "--help", "ses\0bad"])("invalid resume is refused before opencode export runs: %j", async (resume) => {
  const run = vi.fn<ExecutableRunner>();
  await expect(prepareOpenCodePrompts("opencode", { cwd: "/project", resume, systemPrompt: "replacement" }, run)).rejects.toMatchObject({
    name: "UnsupportedOptionError",
    option: "resume",
  });
  expect(run).not.toHaveBeenCalled();
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

const v2 = (minor: number, patch: number) => ({ major: 2, minor, patch, version: `2.${String(minor)}.${String(patch)}` }) as const;
const agents = (list: readonly Record<string, unknown>[]) => json(list);

test("v2 replaces the system prompt of every visible primary agent, listed on a private server in the session cwd and env", async () => {
  const run = vi.fn<ExecutableRunner>().mockResolvedValue(agents([
    { id: "build", mode: "primary", hidden: false },
    { id: "review", mode: "all" },
    { id: "compaction", mode: "primary", hidden: true },
    { id: "explore", mode: "subagent" },
  ]));
  const prepared = await prepareOpenCodeV2Prompts("opencode", v2(3, 2), { cwd: "/project", resume: "ses_old", systemPrompt: "literal {env:SECRET}", env: { PROBE_ENV: "yes" } }, run);
  cleanups.push(prepared.cleanup);
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]?.slice(0, 2)).toEqual(["opencode", ["debug", "agents", "--standalone"]]);
  expect(run.mock.calls[0]?.[2]).toMatchObject({ cwd: "/project", env: { PROBE_ENV: "yes" }, timeoutMs: 30_000 });
  const content = prepared.options.env?.OPENCODE_CONFIG_CONTENT ?? "";
  expect(content).not.toContain("{env:");
  expect(JSON.parse(content)).toEqual({ agents: { build: { system: "literal {env:SECRET}" }, review: { system: "literal {env:SECRET}" } } });
  expect(prepared.agents).toEqual(["build", "review"]);
});

test("v2 append is one private instructions file and queries no agents", async () => {
  const run = vi.fn<ExecutableRunner>();
  const prepared = await prepareOpenCodeV2Prompts("opencode", v2(0, 30), { cwd: "/project", appendSystemPrompt: "appended" }, run);
  cleanups.push(prepared.cleanup);
  expect(run).not.toHaveBeenCalled();
  const instructions = asRecord(JSON.parse(prepared.options.env?.OPENCODE_CONFIG_CONTENT ?? ""))?.instructions;
  assert.ok(Array.isArray(instructions) && typeof instructions[0] === "string");
  expect(await readFile(instructions[0], "utf8")).toBe("appended");
  expect(prepared.agents).toBeUndefined();
});

test.each([
  { release: v2(0, 29), option: "appendSystemPrompt", floor: "2.0.30" },
  { release: { ...v2(0, 30), version: "2.0.30-rc.1" }, option: "appendSystemPrompt", floor: "2.0.30" },
  { release: v2(1, 4), option: "systemPrompt", floor: "2.2.0" },
  { release: v2(1, 99), option: "systemPrompt", floor: "2.2.0" },
  { release: { ...v2(2, 0), version: "2.2.0-beta" }, option: "systemPrompt", floor: "2.2.0" },
] as const)("v2 $release.version refuses $option below its measured floor before any query", async ({ release, option, floor }) => {
  const run = vi.fn<ExecutableRunner>();
  const refusal: unknown = await prepareOpenCodeV2Prompts("opencode", release, { cwd: "/", [option]: "text" }, run).catch((error: unknown) => error);
  expect(refusal).toMatchObject({ name: "UnsupportedOptionError", option });
  expect(String(refusal)).toContain(floor);
  expect(run).not.toHaveBeenCalled();
});

test("v2 refuses when no visible primary agent exists, and when the listing is not a list", async () => {
  const subagentsOnly = vi.fn<ExecutableRunner>().mockResolvedValue(agents([{ id: "explore", mode: "subagent" }]));
  await expect(prepareOpenCodeV2Prompts("opencode", v2(3, 2), { cwd: "/", systemPrompt: "base" }, subagentsOnly))
    .rejects.toMatchObject({ name: "UnsupportedOptionError", option: "systemPrompt" });
  const malformed = vi.fn<ExecutableRunner>().mockResolvedValue({ ok: true, stdout: "private malformed content", stderr: "", exitCode: null });
  await expect(prepareOpenCodeV2Prompts("opencode", v2(3, 2), { cwd: "/", systemPrompt: "base" }, malformed))
    .rejects.toThrow("opencode debug agents returned no agent list while resolving the session's agents");
});

test("v2 refuses malformed inline config and empty prompts", async () => {
  const run = vi.fn<ExecutableRunner>();
  await expect(prepareOpenCodeV2Prompts("opencode", v2(3, 2), { cwd: "/", systemPrompt: "x", env: { OPENCODE_CONFIG_CONTENT: "{" } }, run)).rejects.toMatchObject({ name: "UnsupportedOptionError" });
  await expect(prepareOpenCodeV2Prompts("opencode", v2(3, 2), { cwd: "/", systemPrompt: "" }, run)).rejects.toMatchObject({ name: "UnsupportedOptionError" });
  expect(run).not.toHaveBeenCalled();
});

test("v2 read-back accepts any configured agent and rejects another or a missing one", () => {
  expect(() => { verifyOpenCodeAgents({ configOptions: [{ category: "mode", currentValue: "review" }] }, ["build", "review"]); }).not.toThrow();
  expect(() => { verifyOpenCodeAgents({ configOptions: [{ category: "mode", currentValue: "plan" }] }, ["build"]); }).toThrow('opened on agent "plan", but the system prompt was configured for "build"');
  expect(() => { verifyOpenCodeAgents({}, ["build"]); }).toThrow("opened on agent <unreported>");
});

test.each([v2(0, 30), v2(1, 0), v2(2, 7), v2(3, 2), v2(10, 0), { ...v2(3, 2), version: "2.3.2-1" }])("v2 $version accepts appendSystemPrompt", async (release) => {
  const prepared = await prepareOpenCodeV2Prompts("opencode", release, { cwd: "/", appendSystemPrompt: "text" }, vi.fn<ExecutableRunner>());
  cleanups.push(prepared.cleanup);
  expect(prepared.options.env?.OPENCODE_CONFIG_CONTENT).toContain("instructions");
});

test.each([v2(2, 0), v2(2, 7), v2(3, 2), v2(10, 0)])("v2 $version accepts systemPrompt", async (release) => {
  const prepared = await prepareOpenCodeV2Prompts("opencode", release, { cwd: "/", systemPrompt: "text" }, vi.fn<ExecutableRunner>().mockResolvedValue(agents([{ id: "build", mode: "primary" }])));
  cleanups.push(prepared.cleanup);
  expect(prepared.agents).toEqual(["build"]);
});

const lines = [
  { version: 1, group: "agent", field: "prompt" },
  { version: 2, group: "agents", field: "system" },
] as const;

for (const { version, group, field } of lines) {
  // oxlint-disable-next-line typescript/promise-function-async -- Bind the measured v2 release to the same runner signature.
  const prepare = version === 1 ? prepareOpenCodePrompts : (command: string, options: Parameters<typeof prepareOpenCodePrompts>[1], run: ExecutableRunner) =>
    prepareOpenCodeV2Prompts(command, v2(3, 2), options, run);
  // oxlint-disable-next-line typescript/promise-function-async -- Synchronous reply from a scripted native command.
  const debug: ExecutableRunner = (_command, _args, options) => {
    const host = asRecord(JSON.parse(options?.env?.OPENCODE_CONFIG_CONTENT ?? "{}"));
    const build = asRecord(asRecord(host?.[group])?.build);
    return Promise.resolve(version === 1 ? json(host) : agents([{ id: "build", mode: "primary", ...build }]));
  };
  // oxlint-disable-next-line max-statements -- Inspect the merged bytes and the native debug call for the same open.
  test.each(["systemPrompt", "appendSystemPrompt"] as const)(`v${String(version)} merges %s into inline config and passes the merged fields to native verification`, async option => {
    const run = vi.fn<ExecutableRunner>(debug);
    const original = { provider: { configured: { name: "existing" } }, [group]: { build: { model: "existing/model" }, child: { [field]: "keep" } }, instructions: ["first.md"] };
    const content = JSON.stringify(original).replace('"existing"', String.raw`"unchanged {env:NAME} and \u007bfile:path}"`);
    const prepared = await prepare("opencode", { cwd: "/project", env: { OPENCODE_CONFIG_CONTENT: content }, [option]: "host {env:NAME}" }, run);
    cleanups.push(prepared.cleanup);
    const merged = prepared.options.env?.OPENCODE_CONFIG_CONTENT;
    assert.ok(typeof merged === "string");
    expect(merged).toContain(String.raw`unchanged {env:NAME} and \u007bfile:path}`);
    expect(run.mock.calls.at(-1)?.[2]?.env?.OPENCODE_CONFIG_CONTENT).toBe(merged);
    const expectedAgent = { build: { model: "existing/model", ...(option === "systemPrompt" ? { [field]: "host {env:NAME}" } : {}) }, child: { [field]: "keep" } };
    expect(JSON.parse(merged)).toEqual({ ...JSON.parse(content), [group]: expectedAgent, instructions: option === "systemPrompt" ? ["first.md"] : ["first.md", expect.any(String)] });
  });

  test(`v${String(version)} refuses a replacement dropped by native debug`, async () => {
    const answer = version === 1 ? json({ agent: { build: {} } }) : agents([{ id: "build", mode: "primary" }]);
    const run = vi.fn<ExecutableRunner>().mockResolvedValue(answer);
    await expect(prepare("opencode", { cwd: "/", env: { OPENCODE_CONFIG_CONTENT: "{}" }, systemPrompt: "required" }, run)).rejects.toThrow(`${group}.build.${field}`);
  });

  test(`v${String(version)} refuses only a target prompt field owned by both parties`, async () => {
    const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ [group]: { build: { [field]: "private instructions" } } }) };
    const run = vi.fn<ExecutableRunner>(debug);
    await expect(prepare("opencode", { cwd: "/", env, systemPrompt: "replacement" }, run)).rejects.toThrow(`${group}.build.${field}`);
    const appended = await prepare("opencode", { cwd: "/", env, appendSystemPrompt: "extra" }, run);
    cleanups.push(appended.cleanup);
    expect(JSON.parse(appended.options.env?.OPENCODE_CONFIG_CONTENT ?? "{}")).toMatchObject({ [group]: { build: { [field]: "private instructions" } } });
  });
}

test("a merged config rejected by native debug releases its temporary append file", async () => {
  const files: string[] = [];
  const run: ExecutableRunner = async (_command, _args, options) => {
    const value = asRecord(JSON.parse(options?.env?.OPENCODE_CONFIG_CONTENT ?? "{}"))?.instructions;
    assert.ok(Array.isArray(value) && typeof value[0] === "string");
    files.push(value[0]);
    await access(value[0]);
    throw new Error("native debug failed");
  };
  await expect(prepareOpenCodePrompts("opencode", { cwd: "/", env: { OPENCODE_CONFIG_CONTENT: "{}" }, appendSystemPrompt: "extra" }, run)).rejects.toThrow("native debug failed");
  const [file] = files;
  assert.ok(file !== undefined);
  await expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });
});

test("v1 refuses when native debug moves the host append away from the last entry", async () => {
  // oxlint-disable-next-line typescript/promise-function-async -- Synchronous reply from a scripted native command.
  const run: ExecutableRunner = (_command, _args, options) => {
    const config = asRecord(JSON.parse(options?.env?.OPENCODE_CONFIG_CONTENT ?? "{}"));
    const files = config?.instructions;
    assert.ok(Array.isArray(files));
    return Promise.resolve(json({ instructions: [files.at(-1), "later.md"].filter((file): file is string => typeof file === "string") }));
  };
  await expect(prepareOpenCodePrompts("opencode", { cwd: "/", env: { OPENCODE_CONFIG_CONTENT: "{}" }, appendSystemPrompt: "required" }, run)).rejects.toThrow("last instructions entry");
});
