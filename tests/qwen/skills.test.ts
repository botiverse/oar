import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { qwenRuntime } from "../../packages/oar/src/runtimes/qwen/index.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { fakeAgentBinary } from "../fixtures/process-tree.js";

const cwd = mkdtempSync(path.join(tmpdir(), "oar-qwen-skills-unit-"));
const command = fakeAgentBinary(cwd, [path.resolve(import.meta.dirname, "../fixtures/fake-qwen-skills.mjs")]);
const installation = { kind: "available", via: "executable", command } as const;
afterAll(() => { rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });
const row = { kind: "skill", status: "ok", name: "fixture", description: "native description", installedPath: "/fixture/SKILL.md", level: "project", modelInvocable: true, body: "PRIVATE_BODY" };
const snapshot = { v: 1, initialized: true, workspaceCwd: cwd, skills: [row] };
async function query(value: unknown) {
  return qwenRuntime.skills(installation, { cwd, env: { FAKE_QWEN_SKILLS_RESULT: JSON.stringify(value) } });
}

test("queries the selected workspace and environment before any session or prompt", async () => {
  const trace = path.join(cwd, "trace.jsonl");
  const result = await qwenRuntime.skills(installation, { cwd, env: { FAKE_QWEN_SKILLS_TRACE: trace, FAKE_QWEN_SKILLS_RESULT: JSON.stringify(snapshot) } });
  expect(result).toMatchObject({ kind: "ok", scope: { kind: "workspace", cwd }, view: "discovered", partial: false,
    items: [{ name: "fixture", description: "native description", path: "/fixture/SKILL.md", source: "project", scope: "project", enabled: true, disableModelInvocation: false }] });
  expect(JSON.stringify(result)).not.toContain("PRIVATE_BODY");
  const calls = readFileSync(trace, "utf8").trim().split("\n").map((line: string) => asRecord(parseJson(line)));
  expect(calls.map(call => call?.method)).toEqual(["initialize", "qwen/status/workspace/skills"]);
});

test("native scope, extension identity and disabled flags remain independent", async () => {
  const levels = ["bundled", "user", "project", "extension", "future"];
  // oxlint-disable-next-line oxc/no-map-spread -- Independent metadata rows test native classifications.
  const result = await query({ ...snapshot, skills: levels.map(level => ({ ...row, level, status: "disabled", modelInvocable: false, extensionName: "plugin-native" })) });
  assert.equal(result.kind, "ok");
  expect(result.items.map(skill => skill.scope)).toEqual(["builtin", "user", "project", "other", undefined]);
  expect(result.items.every(skill => skill.plugin === "plugin-native" && skill.enabled === false && skill.disableModelInvocation === true)).toBe(true);
});

test("complete empty catalog and native partial errors are distinct", async () => {
  expect(await query({ ...snapshot, skills: [] })).toMatchObject({ kind: "ok", partial: false, items: [] });
  expect(await query({ ...snapshot, errors: [{ error: "PRIVATE_ERROR" }] })).toMatchObject({ kind: "ok", partial: true });
  expect(JSON.stringify(await query({ ...snapshot, errors: [{ error: "PRIVATE_ERROR" }] }))).not.toContain("PRIVATE_ERROR");
});

test.each([{}, { ...snapshot, initialized: false }, { ...snapshot, v: 2 }, { ...snapshot, skills: {} }, { ...snapshot, skills: [null] },
  { ...snapshot, skills: [{ ...row, status: "unknown" }] }, { ...snapshot, skills: [{ ...row, modelInvocable: "false" }] }, { ...snapshot, errors: "bad" }])("invalid/uninitialized catalog fails closed: %j", async value => {
  expect(await query(value)).toMatchObject({ kind: "unavailable", code: "query_failed" });
});

test.each(["unsupported", "error", "exit", "hang"])("native %s is reported without raw errors", async mode => {
  const result = await qwenRuntime.skills(installation, { cwd, env: { FAKE_QWEN_SKILLS_MODE: mode }, timeoutMs: mode === "hang" ? 500 : 10_000 });
  expect(result).toMatchObject(mode === "unsupported" ? { kind: "unsupported", code: "native_query_unavailable" } : { kind: "unavailable", code: mode === "hang" ? "timeout" : "query_failed" });
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
});

test.each([0, -1, Infinity, NaN])("invalid timeout rejects before launch: %s", async timeoutMs => {
  await expect(qwenRuntime.skills(installation, { cwd, timeoutMs })).rejects.toThrow(RangeError);
});

test("Qwen retains explicit invocation flags without defaulting absent metadata", async () => {
  // oxlint-disable-next-line oxc/no-map-spread -- Keep the common native fixture immutable across cases.
  const skills = [true, false, undefined, "false"].map(userInvocable => ({ ...row, userInvocable }));
  const result = await query({ ...snapshot, skills });
  assert.equal(result.kind, "ok");
  expect(result.items.map(skill => skill.userInvocable)).toEqual([true, false, undefined, undefined]);
  expect(result.items[2]).not.toHaveProperty("userInvocable");
  expect(result.items[3]).not.toHaveProperty("userInvocable");
});
