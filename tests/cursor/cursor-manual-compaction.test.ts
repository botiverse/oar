/* oxlint-disable eslint/max-statements -- A native run and its queue form one ordered scenario. */
import assert from "node:assert/strict";
import { setImmediate as settle } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { FakeCursorAgent, openFakeCursor } from "../fixtures/fake-cursor-sdk.js";

const summary = (run_id: string, status: string, agent_id = "agent-1") => ({ type: "summary", run_id, agent_id, status });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
async function open() {
  const f = await openFakeCursor(); assert.ok(f.session.compact !== undefined);
  return { ...f, compact: f.session.compact.bind(f.session) };
}
test("Cursor summary identity, run terminal and queue order are all required", async () => {
  const f = await open();
  try {
    const waiting = f.compact(); await settle();
    const run = f.agent.latest(); expect(run.message).toBe("native-summary");
    run.streamMessage(summary("other-run", "completed"));
    run.streamMessage(summary(run.id, "completed", "child"));
    await settle();
    expect(await f.compact()).toMatchObject({ kind: "rejected", code: "busy" });
    expect(await f.session.steer("must-not-steer")).toMatchObject({ kind: "rejected", code: "busy" });
    run.streamMessage(summary(run.id, "running"));
    run.streamMessage(summary(run.id, "completed")); await settle();
    expect(await f.session.prompt("too-early")).toMatchObject({ kind: "rejected", code: "busy" });
    await f.session.queue("first");
    run.end("finished");
    expect(await waiting).toMatchObject({ kind: "completed", frame: { spanId: run.id, body: { native: { status: "completed", run_id: run.id, agent_id: "agent-1" } } } });
    expect(f.agent.latest().message).toBe("first");
    expect(await f.session.prompt("overtake")).toMatchObject({ kind: "rejected", code: "busy" });
  } finally { await f.session.dispose(); }
});
test.each(["error", "cancelled", "missing"] as const)("Cursor %s is not a successful compaction", async (mode) => {
  const f = await open();
  try {
    const waiting = f.compact(); await settle(); const run = f.agent.latest();
    if (mode === "error") { run.streamMessage(summary(run.id, "error")); run.end("finished"); }
    else if (mode === "cancelled") { await f.session.abort(); }
    else { run.end("finished"); }
    // oxlint-disable-next-line eslint/no-nested-ternary -- The table names three independent native outcomes.
    expect(await waiting).toMatchObject(mode === "error" ? { kind: "failed", code: "native_failed" } : (mode === "cancelled" ? { kind: "aborted", frame: { body: { type: "cursor/run_result" } } } : { kind: "unconfirmed", code: "observation_failed" }));
    expect(f.session.status().value.kind).toBe("idle");
    if (mode !== "error") { expect(f.session.records().some(r => r.kind === "frame" && r.body.events.some(e => e.kind === "compaction_ended"))).toBe(false); }
    expect(await f.session.prompt("reusable")).toMatchObject({ kind: "accepted" });
  } finally { await f.session.dispose(); }
});
test("Cursor wait timeout does not cancel the native summary or discard a late completed summary", async () => {
  const f = await open();
  try {
    expect(await f.compact({ timeoutMs: 1 })).toMatchObject({ kind: "unconfirmed", code: "timeout" });
    const run = f.agent.latest(); expect(run.cancelled).toBe(false);
    expect(await f.compact()).toMatchObject({ kind: "rejected", code: "busy" });
    run.streamMessage(summary(run.id, "completed")); run.end("cancelled");
    await settle(); expect(f.session.status().value.kind).toBe("idle");
    expect(f.session.records().some(r => r.kind === "frame" && r.body.events.some(e => e.kind === "compaction_ended" && e.outcome === "completed"))).toBe(true);
  } finally { await f.session.dispose(); }
});
test("a disposed launching summary is cancelled if the SDK returns it later", async () => {
  const f = await open(); const gate = Promise.withResolvers<void>(); f.agent.gate = gate.promise;
  const waiting = f.compact(); await f.session.dispose();
  expect(await waiting).toMatchObject({ kind: "unconfirmed", code: "disposed" });
  gate.resolve(); await settle();
  expect(f.agent.latest().cancelled).toBe(true);
});
test("a missing SDK method omits the member, and native startup refusal is typed", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(FakeCursorAgent.prototype, "summarize"); assert.ok(descriptor);
  // A host's SDK stand-in is allowed to omit the optional method.
  Object.defineProperty(FakeCursorAgent.prototype, "summarize", { value: undefined, configurable: true });
  try { const f = await openFakeCursor(); expect(f.session.compact === undefined).toBe(true); await f.session.dispose(); }
  finally { Object.defineProperty(FakeCursorAgent.prototype, "summarize", descriptor); }
  const f = await open();
  try { f.agent.refuse = new Error("No saved conversation"); expect(await f.compact()).toMatchObject({ kind: "rejected", code: "runtime_refused" }); }
  finally { await f.session.dispose(); }
});

test.each(["wait", "stream"] as const)("Cursor %s observation loss does not fabricate a compaction failure or release an unknown run", async (source) => {
  const f = await open();
  try {
    const waiting = f.compact(); await settle(); const run = f.agent.latest();
    if (source === "wait") { run.fail(new Error("transport disconnected")); }
    else { run.closeStream(new Error("message stream disconnected")); }
    expect(await waiting).toMatchObject({ kind: "unconfirmed", code: "observation_failed" });
    expect(await f.compact()).toMatchObject({ kind: "rejected", code: "busy" });
    expect(await f.session.prompt("must-not-send")).toMatchObject({ kind: "rejected", code: "busy" });
    expect(f.session.status().value).toMatchObject({ kind: "running", phase: "compacting" });
    if (source === "wait") { expect(f.session.records().flatMap(r => r.kind === "frame" && r.body.type === "cursor/run_failed" ? [r.body.events] : [])).toEqual([[]]); }
    expect(f.session.records().some(r => r.kind === "frame" && r.body.events.some(e => e.kind === "compaction_ended"))).toBe(false);
    if (source === "stream") {
      run.end("finished"); await settle();
      expect(await f.session.prompt("after-known-end")).toMatchObject({ kind: "accepted" });
    }
  } finally { await f.session.dispose(); }
});

test.each(["other-run", "other-agent"] as const)("a terminal %s summary cannot prove this run compacted", async (foreign) => {
  const f = await open();
  try {
    const waiting = f.compact(); await settle(); const run = f.agent.latest();
    run.streamMessage(summary(foreign === "other-run" ? "old-run" : run.id, "completed", foreign === "other-agent" ? "child" : "agent-1"));
    run.end("finished");
    expect(await waiting).toMatchObject({ kind: "unconfirmed", code: "observation_failed" });
    expect(await f.session.prompt("after-known-terminal")).toMatchObject({ kind: "accepted" });
  } finally { await f.session.dispose(); }
});
