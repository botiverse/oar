/* oxlint-disable import/max-dependencies -- Controlled query timing is checked at the public session control boundary. */
import { afterEach, expect, test, vi } from "vitest";
import { claudeProjectionProfile, initialClaudeProjection } from "../../packages/oar/src/runtimes/claude/projection.js";
import { withSessionCredentials } from "../../packages/oar/src/shared/session-credentials.js";
import { streamJsonSession } from "../../packages/oar/src/shared/stream-json/session.js";
import { observeBeforeCancellation, type CancellationObservation } from "../../packages/oar/src/shared/executable/process-cancellation.js";
import type { ProcessTableObservation } from "../../packages/oar/src/shared/executable/process-tree.js";
// oxlint-disable-next-line import/no-namespace -- Delay just the shared query, not the cancellation budget.
import * as tables from "../../packages/oar/src/shared/executable/process-table-async.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";

const failed: ProcessTableObservation = { ok: false, source: "windows", reason: "timeout", elapsedMs: 5000, timeoutMs: 5000 };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
async function open(child: FakeLineProcess) {
  return withSessionCredentials(async (_i, _o, credentials) => streamJsonSession(child, "session", credentials, {
    projection: claudeProjectionProfile, initial: initialClaudeProjection,
    capabilities: { queue: { durable: false }, attribution: "attributed", images: false },
    steer: true, consume: () => false, open: async () => {}, exited: () => {}, disposing: () => {},
  }))({ kind: "available", via: "executable", command: "fixture" }, { cwd: "/work" });
}
function answer(text: string, child: FakeLineProcess, refusal = false): void {
  const value = asRecord(parseJson(text));
  if (value?.type !== "control_request") { return; }
  child.emit(`${JSON.stringify({ type: "control_response", response: { subtype: refusal ? "error" : "success", request_id: value.request_id, response: {} } })}\n`);
}
function endTurn(child: FakeLineProcess): void { child.emit(`${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`); }

// oxlint-disable-next-line eslint/max-statements -- The exact 999/1000ms boundary and late result share one observation.
test("one-second timeout dispatches interrupt without waiting for a shared query's late result", async () => {
  vi.useFakeTimers();
  const child = fakeLineProcess(answer);
  const gate = Promise.withResolvers<ProcessTableObservation>();
  const read = vi.spyOn(tables, "observeProcessTableAsync").mockReturnValue(gate.promise);
  const results: ProcessTableObservation[] = [];
  const commit = vi.fn<() => void>(), complete = vi.fn<() => void>();
  vi.spyOn(child, "observeCancellation").mockImplementation(async () => {
    const result = await observeBeforeCancellation(); results.push(result); return { commit, complete };
  });
  const session = await open(child);
  try {
    await session.prompt("A");
    const abort = session.abort();
    await vi.advanceTimersByTimeAsync(999);
    expect(child.written).toHaveLength(1); expect(commit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const result = await abort;
    expect(result.kind).toBe("accepted");
    expect(read).toHaveBeenCalledOnce(); expect(commit).toHaveBeenCalledOnce();
    expect(results).toEqual([expect.objectContaining({ ok: false, reason: "timeout", timeoutMs: 1000 })]);
    gate.resolve(failed); await vi.advanceTimersByTimeAsync(0);
    expect(results).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(9999); expect(child.killed()).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(child.killed()).toBe(true);
    expect(complete).toHaveBeenCalledOnce();
  } finally { gate.resolve(failed); await session.dispose(); }
});

// oxlint-disable-next-line eslint/max-statements -- A native turn end races the observation and must release B without cancelling it.
test("a turn ending during observation releases the queue and never sends its cancel to B", async () => {
  const child = fakeLineProcess(answer);
  const gate = Promise.withResolvers<CancellationObservation>();
  const commit = vi.fn<() => void>(), complete = vi.fn<() => void>();
  vi.spyOn(child, "observeCancellation").mockReturnValue(gate.promise);
  const session = await open(child);
  try {
    await session.prompt("A"); await session.queue("B");
    const abort = session.abort(); endTurn(child);
    await Promise.resolve();
    expect(child.written).toHaveLength(1);
    gate.resolve({ commit, complete });
    const result = await abort;
    expect(result.response.body).toMatchObject({ kind: "rejected", code: "no_active_turn" });
    await Promise.resolve();
    expect(commit).not.toHaveBeenCalled(); expect(complete).toHaveBeenCalledOnce();
    expect(child.written).toHaveLength(2);
    expect(child.written.some(text => text.includes("interrupt"))).toBe(false);
    expect(child.written[1]).toContain("B");
  } finally { gate.resolve({ commit, complete }); await session.dispose(); }
});

// oxlint-disable-next-line eslint/max-statements -- Repetition and the following turn must share one session lifetime.
test("repeated interrupts share one observation and the next turn gets a fresh one", async () => {
  const child = fakeLineProcess(answer);
  const commit = vi.fn<() => void>(), complete = vi.fn<() => void>();
  const observe = vi.spyOn(child, "observeCancellation").mockResolvedValue({ commit, complete });
  const session = await open(child);
  try {
    await session.prompt("A");
    const results = await Promise.all([session.abort(), session.abort()]);
    expect(results.map(result => result.kind)).toEqual(["accepted", "accepted"]);
    expect(observe).toHaveBeenCalledOnce();
    await session.abort(); expect(observe).toHaveBeenCalledOnce();
    endTurn(child); expect(complete).toHaveBeenCalledOnce();
    await session.prompt("B"); await session.abort(); expect(observe).toHaveBeenCalledTimes(2);
  } finally { await session.dispose(); }
});

// oxlint-disable-next-line eslint/max-statements -- Native refusal must clear both the ownership marker and deadline.
test("native refusal does not leave cancellation active or keep its kill fallback", async () => {
  vi.useFakeTimers();
  const child = fakeLineProcess((text, process) => { answer(text, process, true); });
  const complete = vi.fn<() => void>();
  vi.spyOn(child, "observeCancellation").mockResolvedValue({ commit() {}, complete });
  const session = await open(child);
  try {
    await session.prompt("A"); const result = await session.abort(); expect(result.kind).toBe("rejected");
    expect(complete).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_001); expect(child.killed()).toBe(false);
  } finally { await session.dispose(); }
});
