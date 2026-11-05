/* oxlint-disable import/max-dependencies -- One public-API suite over the real bridge text and a stand-in executable. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { dshRuntime, RuntimeFailureError, SessionNotFoundError, UnsupportedOptionError, type Session } from "../../packages/oar/src/index.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { dshBridgeSource } from "../../packages/oar/src/runtimes/dsh/bridge.js";
import { dshAgentOptions } from "../../packages/oar/src/runtimes/dsh/options.js";
import { spawnLineProcess as spawnLine } from "../../packages/oar/src/shared/executable/index.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { fakeAgentBinary } from "../fixtures/process-tree.js";

/*
 * Public Session API against a stand-in executable that runs the real bridge
 * text over fake services, for faults a healthy DSH never produces. What real
 * DSH does is pinned in sea-trial/vendor/dsh.vendor.test.ts.
 */
const dir = mkdtempSync(path.join(tmpdir(), "oar-dsh-session-"));
const command = fakeAgentBinary(dir, [path.resolve(import.meta.dirname, "../fixtures/fake-dsh.mjs")]);
const cwd = dir;
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

async function open(env: Readonly<Record<string, string>> = {}, options: { readonly resume?: string; readonly model?: string; readonly effort?: string } = {}): Promise<Session> {
  const session = await dshRuntime.session({ kind: "available", via: "executable", command, version: "0.2.1-rc.5" }, { cwd, env, ...options });
  return session;
}

const failure = async (env: Readonly<Record<string, string>>, options: Parameters<typeof open>[1] = {}): Promise<unknown> => {
  const result = await open(env, options).catch((error: unknown) => error);
  return result;
};

const frameTypes = (session: Session): readonly string[] => session.records().flatMap((record) => record.kind === "frame" ? [record.body.type] : []);

describe("the bridge source", () => {
  test("imports no DSH package, in code or text", () => {
    expect(dshBridgeSource).not.toContain("@deepseek-ai/");
    expect(dshBridgeSource).not.toContain("release");
    expect(dshBridgeSource).not.toContain("oar_probe_echo");
  });

  test("is valid JavaScript as written to disk", () => {
    const file = path.join(dir, "bridge-check.mjs");
    writeFileSync(file, dshBridgeSource);
    const checked = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    expect(checked.stderr).toBe("");
    expect(checked.status).toBe(0);
  });
});

test.each([["below the floor", "0.2.1-rc.4", "DSH 0.2.1-rc.4 is below the supported floor; OAR requires 0.2.1-rc.5 or later"], ["no readable version", "nightly", 'DSH reported the unreadable version "nightly"; OAR requires 0.2.1-rc.5 or later']])("an open is refused %s, naming it", async (_case, version, reason) => {
  const refused = await dshRuntime.session({ kind: "available", via: "executable", command, version }, { cwd }).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(RuntimeFailureError);
  expect(refused).toMatchObject({ failure: "invalid_request", message: reason });
});

test("an installation that names no version is checked against the executable before anything starts", async () => {
  const refused = await dshRuntime.session({ kind: "available", via: "executable", command }, { cwd, env: { FAKE_DSH_VERSION: "0.2.1-rc.1" } }).catch((error: unknown) => error);
  expect(refused).toMatchObject({ failure: "invalid_request", message: "DSH 0.2.1-rc.1 is below the supported floor; OAR requires 0.2.1-rc.5 or later" });
  const session = await dshRuntime.session({ kind: "available", via: "executable", command }, { cwd });
  await session.dispose();
});

test("a model that is not provider/model is refused before anything starts", () => {
  expect(dshAgentOptions({ model: "p/m/with-slash", effort: "low" })).toEqual({ provider: "p", model: "m/with-slash", reasoningEffort: "low" });
  expect(dshAgentOptions({})).toEqual({});
  for (const model of ["bare", "/m", "p/"]) {
    expect(() => dshAgentOptions({ model })).toThrow(UnsupportedOptionError);
  }
});

test.each([
  ["a failed loader barrier", { FAKE_DSH_MODE: "barrier-fails" }, "barrier failed"],
  ["a missing loader", { FAKE_DSH_MODE: "no-loader" }, "This DSH does not provide loader.await(), which starting the bridge requires"],
  ["a process that exits before ready", { FAKE_DSH_MODE: "exit-before-ready" }, "native startup failed"],
])("%s fails the open with the native words, never an empty inventory", async (_case, env, words) => {
  const error = await failure(env);
  assert.ok(error instanceof Error);
  expect(error.message).toContain(words);
});

test("a session the runtime opened under another id is refused", async () => {
  const error = await failure({ FAKE_DSH_MODE: "wrong-id" });
  assert.ok(error instanceof Error);
  expect(error.message).toMatch(/^DSH opened another-id, not /u);
});

test("a missing factory method is a typed refusal with its reason", async () => {
  expect(await failure({ FAKE_DSH_MISSING: "create" })).toMatchObject({ name: "RuntimeFailureError", message: "This DSH does not provide create(), which opening a session requires" });
  const resumed = await failure({ FAKE_DSH_MISSING: "resume" }, { resume: "11111111-1111-4111-8111-111111111111" });
  expect(resumed).toBeInstanceOf(UnsupportedOptionError);
  expect(resumed).toMatchObject({ option: "resume", message: "This DSH does not provide resume(), which resuming a session requires" });
  const peek = await failure({ FAKE_DSH_MISSING: "open" }, { resume: "11111111-1111-4111-8111-111111111111" });
  expect(peek).toMatchObject({ option: "resume", message: "This DSH does not provide open(), which reading a saved session before resume requires" });
});

test("native route refusals keep their words and their class", async () => {
  const effort = await failure({}, { effort: "bad" });
  expect(effort).toBeInstanceOf(UnsupportedOptionError);
  expect(effort).toMatchObject({ option: "effort", message: 'does not support reasoning effort "bad"' });
  const model = await failure({}, { model: "p/bad" });
  expect(model).toBeInstanceOf(RuntimeFailureError);
  expect(model).toMatchObject({ failure: "model_unavailable", message: 'no configured model "bad"' });
  expect(await failure({ FAKE_DSH_MISSING: "resolveCallConfig" }, { effort: "high" })).toMatchObject({ option: "effort", message: "This DSH does not provide resolveCallConfig(), which confirming a reasoning effort requires" });
});

test("a selection the runtime reports differently from the request is refused, never run", async () => {
  const model = await failure({ FAKE_DSH_MODEL: JSON.stringify({ provider: "p", model: "other" }) }, { model: "p/m" });
  expect(model).toBeInstanceOf(UnsupportedOptionError);
  expect(model).toMatchObject({ option: "model", message: "DSH did not apply model p/m: it reports p/other" });
  const effort = await failure({ FAKE_DSH_MODEL: JSON.stringify({ provider: "p", model: "m", reasoningEffort: "low" }) }, { model: "p/m", effort: "high" });
  expect(effort).toMatchObject({ option: "effort", message: "DSH did not apply effort high: it reports low" });
  const session = await open({ FAKE_DSH_MODEL: JSON.stringify({ provider: "p", model: "m", reasoningEffort: "high" }) }, { model: "p/m", effort: "high" });
  expect(session.model().value).toBe("p/m");
  expect(session.effort().value).toBe("high");
  await session.dispose();
});

test("resume refuses another directory before taking the session over, and a missing session is SessionNotFoundError", async () => {
  const elsewhere = await failure({ FAKE_DSH_CWD: path.join(dir, "elsewhere") }, { resume: "11111111-1111-4111-8111-111111111111" });
  expect(elsewhere).toBeInstanceOf(UnsupportedOptionError);
  expect(elsewhere).toMatchObject({ option: "cwd" });
  const missing = await failure({}, { resume: "00000000-0000-4000-8000-000000000000" });
  expect(missing).toBeInstanceOf(SessionNotFoundError);
  const resumed = await open({}, { resume: "11111111-1111-4111-8111-111111111111" });
  expect(resumed.id).toBe("11111111-1111-4111-8111-111111111111");
  await resumed.dispose();
});

test("a missing inventory method removes or refuses its control, with the reason", async () => {
  const absent = await open({ FAKE_DSH_MISSING: "steer,remove" });
  expect(absent.steer === undefined).toBe(true);
  expect(absent.withdraw === undefined).toBe(true);
  await absent.dispose();
  const refused = await open({ FAKE_DSH_MISSING: "followup,cancel" });
  expect(typeof refused.steer).toBe("function");
  expect(await refused.prompt("hello")).toMatchObject({ kind: "rejected", code: "unsupported", reason: "This DSH does not provide followup(), which prompt requires" });
  expect(await refused.queue("hello")).toMatchObject({ kind: "rejected", code: "unsupported", reason: "This DSH does not provide followup(), which queue requires" });
  expect(await refused.abort()).toMatchObject({ kind: "rejected", code: "unsupported", reason: "This DSH does not provide cancel(), which abort requires" });
  await refused.dispose();
});

test("listModels reads the native catalog as provider/model selectors", async () => {
  const listed = await dshRuntime.listModels({ kind: "available", via: "executable", command, version: "0.2.1-rc.5" }, { cwd });
  expect(listed).toEqual({ kind: "ok", models: [
    { id: "local/plain", displayName: "Plain", provider: { id: "local", displayName: "Local" } },
    { id: "local/thinks", displayName: "Thinks", provider: { id: "local", displayName: "Local" }, effortLevels: ["low", "high"], defaultEffort: "low", default: true },
  ] });
});

test("a catalog with no provider that could list is unsupported with the native reason; a floor refusal comes first", async () => {
  const failing = await dshRuntime.listModels({ kind: "available", via: "executable", command, version: "0.2.1-rc.5" }, { cwd, env: { FAKE_DSH_MODE: "listing-fails" } });
  expect(failing).toEqual({ kind: "unsupported", reason: "DSH could not list any provider's models: local: no credential; broken: no credential" });
  const old = await dshRuntime.listModels({ kind: "available", via: "executable", command, version: "0.2.1-rc.4" }, { cwd });
  expect(old).toEqual({ kind: "unsupported", reason: "DSH 0.2.1-rc.4 is below the supported floor; OAR requires 0.2.1-rc.5 or later" });
});

test("a line that is not protocol is a recorded frame, not a lost one", async () => {
  const session = await open({ FAKE_DSH_MODE: "stdout-noise" });
  expect(session.records().some((record) => record.kind === "frame" && record.body.type === "dsh/stdout" && JSON.stringify(record.body.native).includes("not json at all"))).toBe(true);
  await session.dispose();
});

test("agent/error carries the structured native error, cause chain included", async () => {
  const session = await open();
  const started = await session.prompt("hello");
  expect(await awaitTurnEnd(session, started.seq)).toEqual({ kind: "completed" });
  const frame = session.records().find((record) => record.kind === "frame" && record.body.type === "agent/error");
  expect(frame?.kind === "frame" ? frame.body.native : null).toEqual({ turn: 1, step: 0, error: { name: "Error", message: "first", code: "X", cause: { name: "Error", message: "second" } } });
  await session.dispose();
  expect(frameTypes(session)[0]).toBe("dsh/ready");
});

// oxlint-disable-next-line max-statements -- One ordered withdraw conversation.
test("a withdraw is only for input held for a later turn, answered from the native list", async () => {
  const session = await open({ FAKE_DSH_MODE: "hold" });
  const first = await session.prompt("one");
  expect(first.kind).toBe("accepted");
  const queued = await session.queue("two");
  expect(queued.kind).toBe("accepted");
  const inputId = queued.request.body.kind === "queue" ? queued.request.body.inputId ?? "" : "";
  const taken = await session.withdraw?.(inputId);
  expect(taken?.kind).toBe("accepted");
  expect(await session.withdraw?.(inputId)).toMatchObject({ kind: "rejected", code: "not_queued" });
  expect(session.records().flatMap((record) => record.kind === "frame" ? record.body.events : []).filter((event) => event.kind === "input_dropped" && event.inputId === inputId)).toEqual([]);
  await session.dispose();
});

test("a dispose whose native close fails still ends the process and records the exit", async () => {
  const session = await open({ FAKE_DSH_MODE: "dispose-fails" });
  await session.dispose();
  expect(session.records().some((record) => record.kind === "response" && record.body.kind === "exited")).toBe(true);
  expect(session.records().some((record) => record.kind === "frame" && record.body.type === "dsh/dispose-failed" && JSON.stringify(record.body.native).includes("native dispose failed"))).toBe(true);
  await session.dispose();
});

// oxlint-disable-next-line max-statements -- Drives the bridge directly, below the session.
test("a line that is no command gets a protocol error frame, and the bridge keeps answering", async () => {
  const bridge = path.join(dir, "protocol-bridge.mjs");
  const patch = path.join(dir, "protocol-patch.json");
  writeFileSync(bridge, dshBridgeSource);
  writeFileSync(patch, JSON.stringify([{ id: "acp", disabled: true }, { insert: [{ id: "oar-dsh-bridge", name: pathToFileURL(bridge).href }] }]));
  const child = spawnLine(command, ["--profile", "acp", "--patch", patch], { cwd });
  const frames: JsonRecord[] = [];
  child.onLine((line) => { frames.push(asRecord(parseJson(line)) ?? {}); });
  const until = async (type: string): Promise<JsonRecord> => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const frame = frames.find((candidate) => candidate.type === type);
      if (frame !== undefined) { return frame; }
      assert.ok(Date.now() < deadline, `no ${type} in ${JSON.stringify(frames)}`);
      // oxlint-disable-next-line no-await-in-loop -- Polling a stream the child writes.
      await delay(10);
    }
  };
  try {
    await until("ready");
    child.write("not json\n");
    child.write(`${JSON.stringify({ id: "1", method: "no-such-method" })}\n`);
    child.write(`${JSON.stringify({ id: "2", method: "dispose" })}\n`);
    await until("response");
    expect(frames.filter((frame) => frame.type === "protocol-error").map((frame) => frame.line)).toEqual(["not json", JSON.stringify({ id: "1", method: "no-such-method" })]);
    expect(frames.find((frame) => frame.type === "response")).toEqual({ type: "response", id: "2", result: {} });
  } finally {
    child.kill();
    await child.exited;
  }
});
