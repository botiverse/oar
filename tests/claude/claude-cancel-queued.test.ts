/* oxlint-disable max-statements -- Native ordering, control replies and folds are checked together. */
import { afterEach, expect, test, vi } from "vitest";
import { claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
import { awaitIdle, awaitTurnEnd, promptAndWait, turnEndAfter } from "../../packages/oar/src/observe/turns.js";
import { viewOf } from "../../packages/oar/src/observe/session-view.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
afterEach(() => { spawnLineProcess.mockReset(); });
const installation = { kind: "available", via: "executable", command: "claude", version: "2.1.292" } as const;
const inputId = "6f1c2d3e-0002-4a5b-8c7d-000000000002";
const emit = (child: FakeLineProcess, message: unknown): void => { child.emit(`${JSON.stringify(message)}\n`); };
const lifecycle = (child: FakeLineProcess, state: string, id = inputId): void => { emit(child, { type: "command_lifecycle", command_uuid: id, state }); };
async function setup(capability = true) {
  const child = fakeLineProcess((text, process) => {
    const request = asRecord(parseJson(text));
    if (request?.type === "control_request") {
      emit(process, { type: "control_response", response: { subtype: "success", request_id: request.request_id } });
    }
  });
  spawnLineProcess.mockReturnValue(child);
  const session = await claudeSession(installation, { cwd: "/work" });
  emit(child, { type: "system", subtype: "init", capabilities: capability ? ["interrupt_cancel_queued_v1"] : [] });
  emit(child, { type: "result", is_error: false });
  return { child, session };
}

test.each(["before-queued", "queued", "notification", "after-notification"])("abort cancels a pending prompt at %s without inventing a turn end", async (stage) => {
  const { child, session } = await setup();
  const prompt = await session.prompt("hello", { inputId });
  const waiting = awaitTurnEnd(session, prompt.seq, inputId);
  try {
    if (stage !== "before-queued") { lifecycle(child, "queued"); }
    if (stage === "notification" || stage === "after-notification") { emit(child, { type: "system", subtype: "init" }); }
    if (stage === "after-notification") { emit(child, { type: "result", is_error: false }); }
    const endCount = session.records().flatMap((r) => r.kind === "frame" ? r.body.events : []).filter((e) => e.kind === "turn_ended").length;
    expect(await session.abort()).toMatchObject({ kind: "accepted" });
    const written = asRecord(parseJson(child.written.at(-1) ?? ""));
    expect(written).toMatchObject({ request: { subtype: "interrupt", cancel_queued: true } });
    lifecycle(child, "cancelled");
    expect(await waiting).toEqual({ kind: "aborted" });
    expect(turnEndAfter(session.records(), prompt.seq, session.id, inputId)).toEqual({ kind: "aborted" });
    const events = session.records().flatMap((r) => r.kind === "frame" ? r.body.events : []);
    expect(events.filter((e) => e.kind === "turn_ended")).toHaveLength(endCount);
    expect(events.filter((e) => e.kind === "input_dropped")).toEqual([{ kind: "input_dropped", inputId, reason: "turn_interrupted" }]);
    expect(session.status().value.kind).toBe(stage === "notification" ? "running" : "idle");
    const view = viewOf(session.records());
    expect(view.pendingInputs).toHaveLength(0);
    expect(view.messages.find((m) => m.kind === "input" && m.input.inputId === inputId)).toMatchObject({ input: { state: "dropped", reason: "turn_interrupted" } });
    expect(view.messages.filter((m) => m.kind === "turn" && m.openedBy === prompt.requestId)).toHaveLength(0);
    if (stage === "notification") { emit(child, { type: "result", is_error: false }); }
    expect(await session.prompt("next")).toMatchObject({ kind: "accepted" });
  } finally { await session.dispose(); }
});

test("a native cancellation sweep ends scoped waits and awaitIdle without an abort request", async () => {
  const { child, session } = await setup();
  const prompt = await session.prompt("hello", { inputId });
  lifecycle(child, "queued");
  const idle = awaitIdle(session);
  try {
    lifecycle(child, "cancelled");
    expect(await idle).toEqual({ kind: "aborted" });
    expect(await awaitTurnEnd(session, prompt.seq, inputId)).toEqual({ kind: "aborted" });
    expect(session.status().value.kind).toBe("idle");
    expect(session.records().some((r) => r.kind === "request" && r.body.kind === "abort")).toBe(false);
  } finally { await session.dispose(); }
});

test.each([false, true])("abort of a started prompt remains an ordinary interrupt, capability=%s", async (capability) => {
  const { child, session } = await setup(capability);
  await session.prompt("hello", { inputId });
  lifecycle(child, "queued"); lifecycle(child, "started");
  try {
    await session.abort();
    const written = asRecord(parseJson(child.written.at(-1) ?? ""));
    expect(written?.request).toEqual({ subtype: "interrupt" });
    emit(child, { type: "result", is_error: false });
    lifecycle(child, "cancelled");
    expect(session.records().flatMap((r) => r.kind === "frame" ? r.body.events : []).filter((e) => e.kind === "input_dropped")).toEqual([]);
  } finally { await session.dispose(); }
});

test("without the declared capability an interrupt leaves the queued prompt for its own result", async () => {
  const { child, session } = await setup(false);
  const prompt = await session.prompt("hello", { inputId });
  lifecycle(child, "queued"); emit(child, { type: "system", subtype: "init" });
  try {
    await session.abort();
    const written = asRecord(parseJson(child.written.at(-1) ?? ""));
    expect(written?.request).toEqual({ subtype: "interrupt" });
    emit(child, { type: "result", is_error: false });
    expect(turnEndAfter(session.records(), prompt.seq, session.id, inputId)).toBeNull();
    lifecycle(child, "started"); emit(child, { type: "result", is_error: false });
    expect(await awaitTurnEnd(session, prompt.seq, inputId)).toEqual({ kind: "completed" });
  } finally { await session.dispose(); }
});

test("promptAndWait signal during a notification resolves on its own native cancellation", async () => {
  const { child, session } = await setup();
  const signal = new AbortController();
  const run = promptAndWait(session, "hello", { inputId, signal: signal.signal });
  await vi.waitFor(() => { expect(child.written).toHaveLength(1); });
  try {
    lifecycle(child, "queued"); emit(child, { type: "system", subtype: "init" });
    emit(child, { type: "assistant", message: { content: [{ type: "text", text: "notification" }] } });
    signal.abort();
    await vi.waitFor(() => { expect(child.written).toHaveLength(2); });
    lifecycle(child, "cancelled");
    expect(await run).toMatchObject({ kind: "interrupted", by: "signal", text: "", outcome: { kind: "aborted" } });
    emit(child, { type: "result", is_error: false });
    expect(session.status().value.kind).toBe("idle");
  } finally { await session.dispose(); }
});

test("awaitIdle keeps waiting when a cancelled input leaves a notification turn running", async () => {
  const { child, session } = await setup();
  await session.prompt("hello", { inputId });
  lifecycle(child, "queued"); emit(child, { type: "system", subtype: "init" });
  let settled = false;
  const idle = (async () => { const outcome = await awaitIdle(session); settled = true; return outcome; })();
  try {
    await session.abort(); lifecycle(child, "cancelled");
    await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false);
    emit(child, { type: "result", is_error: false });
    expect(await idle).toEqual({ kind: "aborted" });
  } finally { await session.dispose(); }
});

test("cancelled before the interrupt receipt needs no result and disarms forced termination", async () => {
  vi.useFakeTimers();
  const child = fakeLineProcess((text, process) => {
    const message = asRecord(parseJson(text));
    if (message?.type !== "control_request") { return; }
    lifecycle(process, "cancelled");
    emit(process, { type: "control_response", response: { subtype: "success", request_id: message.request_id,
      response: { still_queued: [], cancelled: [inputId] } } });
  });
  spawnLineProcess.mockReturnValue(child);
  const session = await claudeSession(installation, { cwd: "/work" });
  emit(child, { type: "system", subtype: "init", capabilities: ["interrupt_cancel_queued_v1"] });
  emit(child, { type: "result", is_error: false });
  const prompt = await session.prompt("hello", { inputId });
  lifecycle(child, "queued");
  try {
    expect(await session.abort()).toMatchObject({ kind: "accepted" });
    expect(await awaitTurnEnd(session, prompt.seq, inputId)).toEqual({ kind: "aborted" });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(child.killed()).toBe(false);
    expect(session.status().value.kind).toBe("idle");
  } finally { await session.dispose(); vi.useRealTimers(); }
});
