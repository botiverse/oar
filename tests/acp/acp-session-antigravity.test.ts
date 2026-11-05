/* oxlint-disable import/max-dependencies -- Native lifecycle controls combine records and owned-process liveness. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { expect, test } from "vitest";
import type { Session, SessionOptions } from "../../packages/oar/src/contracts/session.js";
import {
  antigravityAcpArgs,
  antigravityAcpProfile,
} from "../../packages/oar/src/runtimes/antigravity/session.js";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import { promptAndWait, awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { describe, fixture } from "../fixtures/acp-session-support.js";
import { agentTreeModule, gone, withTreeProbe } from "../fixtures/process-tree.js";

// Replay agy CLI 1.5.0's close capability and thought_level selector.
// Only the executable launch is replaced by the fake transport.
async function startAntigravity(options: Omit<SessionOptions, "cwd"> = {}, keepAlive = false, requestTimeoutMs = 15_000): Promise<Session> {
  return acpSession({
    ...antigravityAcpProfile,
    requestTimeoutMs,
    args: [...(keepAlive ? ["--import", agentTreeModule] : []), fixture, "antigravity"],
  })({ kind: "available", via: "executable", command: process.execPath }, { cwd: process.cwd(), ...options });
}

async function lastText(session: Session, input: string): Promise<string | undefined> {
  const run = await promptAndWait(session, input);
  assert.equal(run.kind, "ended");
  return session.records().map((record) => describe(record)).findLast((line) => line.startsWith("event agent_message_chunk"));
}

test("the session opens without authenticate or a synthetic permission mode, again after a resume", async () => {
  const first = await startAntigravity();
  const opening = first.records().map((record) => describe(record));
  assert.ok(!opening.includes("event authenticate"), JSON.stringify(opening));
  assert.equal(await lastText(first, "mode"), "event agent_message_chunk → text:mode:default");
  await first.dispose();

  const resumed = await startAntigravity({ resume: first.id });
  assert.equal(resumed.id, first.id);
  assert.equal(await lastText(resumed, "mode"), "event agent_message_chunk → text:mode:default");
  await resumed.dispose();
});

test.each([false, true])("dispose closes the native session and ends the process; held open by a tool: %s", async (keepAlive) => {
  // oxlint-disable-next-line eslint/max-statements -- Observe the same disposal's stream, native exit and descendant liveness together.
  await withTreeProbe({ ignoreSigterm: false }, async (probe) => {
    const dir = mkdtempSync(path.join(tmpdir(), "oar-agy-close-"));
    const closeLog = path.join(dir, "close.txt");
    const session = await startAntigravity({ env: { ...(keepAlive ? probe.env : {}), FAKE_ACP_CLOSE_LOG: closeLog } }, keepAlive);
    const tree = keepAlive ? await probe.tree() : null;
    await session.dispose();
    assert.equal(readFileSync(closeLog, "utf8"), `${session.id}\n`);
    rmSync(dir, { recursive: true, force: true });
    const tail = session.records().map((record) => describe(record));
    // Disposal owns the process; the close response is not a session frame.
    assert.deepEqual(tail.slice(-2), ["request dispose", "response exited"]);
    assert.equal(tail.at(-1), "response exited");
    const exit = session.records().findLast((entry) => entry.kind === "response" && entry.body.kind === "exited");
    assert.ok(exit?.kind === "response" && exit.body.kind === "exited");
    if (process.platform === "win32") {
      process.stdout.write(`antigravity dispose: keepAlive=${String(keepAlive)} code=${String(exit.body.code)}\n`);
    } else {
      assert.equal(exit.body.code, null);
    }
    if (tree !== null) {
      assert.deepEqual([await gone(tree.agent), await gone(tree.grandchild)], [true, true], JSON.stringify(tree));
    }
  });
});

test("model and effort go through their native config options on creation and resume", async () => {
  const session = await startAntigravity({ model: "requested-y" });
  const opening = session.records().map((record) => describe(record));
  assert.ok(opening.includes("event session/set_config_option → model:requested-y, effort:medium"), JSON.stringify(opening));
  assert.equal(session.model().value, "requested-y");
  await session.dispose();

  await Promise.all([undefined, "fake-session"].map(async (resume) => {
    const sessionWithEffort = await startAntigravity({ effort: "high", ...(resume === undefined ? {} : { resume }) });
    assert.equal(sessionWithEffort.effort().value, "high");
    await sessionWithEffort.dispose();
  }));
  await expect(startAntigravity({ effort: "bogus" })).rejects.toThrow(/thought_level=bogus was refused/u);
});

test("a turn ends on the prompt answer alone, with no usage_update to wait for", async () => {
  const session = await startAntigravity();
  const run = await promptAndWait(session, "hello");
  assert.equal(run.kind, "ended");
  assert.deepEqual(run.outcome, { kind: "completed" });
  assert.ok(!session.records().some((record) => record.kind === "frame" && record.body.type === "usage_update"));
  await session.dispose();
});

test("the antigravity profile uses native CLI ACP workers and refuses unsupported options", () => {
  assert.deepEqual(antigravityAcpArgs(), ["acp", "--dangerously-skip-permissions", "--process-per-session"]);
  assert.equal(antigravityAcpProfile.modelViaConfigOption, true);
  assert.equal(antigravityAcpProfile.selectAuthMethod, undefined);
  assert.equal(antigravityAcpProfile.capabilities.attribution, "opaque");
  assert.throws(() => antigravityAcpProfile.validateOptions?.({ cwd: "/", systemPrompt: "x" }));
  assert.doesNotThrow(() => antigravityAcpProfile.validateOptions?.({ cwd: "/", appendSystemPrompt: "x" }));
  assert.doesNotThrow(() => antigravityAcpProfile.validateOptions?.({ cwd: "/" }));
});

// oxlint-disable-next-line eslint/max-statements -- One lifecycle control follows the early reply through its real final outcome.
test.each(["completed", "failed", "aborted"] as const)("early prompt success cannot settle a replacing steer: %s", async (expected) => {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-agy-steer-"));
  const gate = path.join(dir, "finish");
  const session = await startAntigravity({ env: { FAKE_ACP_STEER_FINISH: gate, FAKE_ACP_STEER_CANCEL_ERROR: "1" } });
  try {
    const earlier = Promise.withResolvers<void>();
    session.rawEvents((record) => {
      if (record.kind === "frame" && record.body.type === "session/prompt") { earlier.resolve(); }
    });
    const first = await session.prompt("hold");
    const steering = await session.steer?.("agy-steer-pending", { inputId: "c6c6c6c6-c6c6-46c6-86c6-c6c6c6c6c6c6" });
    expect(steering?.response.body.kind).toBe("accepted");
    await earlier.promise;
    expect(session.status().value.kind).toBe("running");
    const outcomes = () => session.records().flatMap((record) => record.kind === "frame" ? record.body.events.filter((event) => event.kind === "turn_ended") : []);
    expect(outcomes()).toHaveLength(0);
    const overlap = await session.prompt("do not overlap");
    expect(overlap.response.body).toMatchObject({ kind: "rejected", code: "busy" });
    if (expected === "aborted") { const abort = await session.abort(); expect(abort.response.body.kind).toBe("accepted"); }
    else { writeFileSync(gate, expected === "failed" ? "error" : "ok"); }
    expect(await awaitTurnEnd(session, first.request.seq)).toMatchObject({ kind: expected });
    expect(outcomes()).toHaveLength(1);
    const terminal = session.records().find((record) => record.kind === "frame" && record.body.events.some((event) => event.kind === "turn_ended"));
    expect(terminal).toMatchObject({ body: { type: expected === "completed" ? "session/prompt" : "session/prompt/error" } });
  } finally { await session.dispose(); rmSync(dir, { recursive: true, force: true }); }
});


test("model notification settles before setting effort, and both notifications are recorded before open returns", async () => {
  const session = await startAntigravity({ model: "requested-y", effort: "high", env: { FAKE_ACP_MODEL_UPDATE_DELAY_MS: "100" } });
  try {
    const configFrames = () => session.records().flatMap(record => record.kind === "frame" && record.body.type === "config_option_update" ? [record] : []);
    expect(configFrames()).toHaveLength(2);
    expect(session.model().value).toBe("requested-y");
    expect(session.effort().value).toBe("high");
    const opening = session.records().map(record => describe(record));
    expect(opening.indexOf("event config_option_update → model:requested-y, effort:medium")).toBeLessThan(opening.indexOf("event session/set_config_option → model:requested-y, effort:high"));
  } finally { await session.dispose(); }
});

test.each(["model", "effort"])("missing %s notification refuses open within the configuration deadline", async kind => {
  await expect(startAntigravity({ model: "requested-y", effort: "high", env: { FAKE_ACP_OMIT_CONFIG_UPDATE: kind } }, false, 1000)).rejects.toThrow(/timed out/u);
});

test("an effort answer alone cannot override a contradictory native notification", async () => {
  await expect(startAntigravity({ model: "requested-y", effort: "high", env: { FAKE_ACP_WRONG_EFFORT_UPDATE: "1" } })).rejects.toThrow(/config_option_update left thought_level at low/u);
});

// oxlint-disable-next-line eslint/max-statements -- Follow only the rejected steer and original prompt, without a third prompt masking the outcome.
test("a refused steer before the original prompt reply cannot poison its later success", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-agy-refused-steer-"));
  const gate = path.join(dir, "finish");
  const session = await startAntigravity({ env: { FAKE_ACP_STEER_FINISH: gate } });
  try {
    const first = await session.prompt("agy-original-held");
    const steering = await session.steer?.("agy-refused-steer", { inputId: "c6c6c6c6-c6c6-46c6-86c6-c6c6c6c6c6c6" });
    expect(steering?.response.body.kind).toBe("accepted");
    const frames = () => session.records().flatMap(record => record.kind === "frame" ? [record.body] : []);
    await expect.poll(() => frames().some(frame => frame.type === "session/prompt/error")).toBe(true);
    expect(frames().find(frame => frame.type === "session/prompt/error")?.native).toMatchObject({ code: -32_602 });
    expect(frames().some(frame => frame.type === "session/prompt")).toBe(false);
    expect(frames().flatMap(frame => frame.events).filter(event => event.kind === "turn_ended")).toHaveLength(0);
    expect(session.status().value.kind).toBe("running");
    writeFileSync(gate, "ok");
    expect(await awaitTurnEnd(session, first.request.seq)).toEqual({ kind: "completed" });
    expect(frames().flatMap(frame => frame.events).filter(event => event.kind === "turn_ended")).toEqual([{ kind: "turn_ended", outcome: { kind: "completed" } }]);
  } finally { await session.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
