import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { aggregateDeltas } from "../packages/oar/src/observe/aggregate-events.js";
import type { SessionObserver } from "../packages/oar/src/index.js";
import { startMockSession } from "../sea-trial/fixtures/mock-session.js";

const aggregateDeltasSync = (observer: SessionObserver): SessionObserver =>
  aggregateDeltas(observer, { maxHoldMs: 100 });

afterEach(() => {
  vi.useRealTimers();
});

async function runAggregated(): Promise<string[]> {
  const { aggregateDeltas: makeAggregate } = await import("../packages/oar/src/observe/aggregate-events.js");
  const session = await startMockSession(
    { kind: "available", via: "bundled" },
    { cwd: process.cwd() },
  );
  const merged: string[] = [];
  session.subscribe(makeAggregate((event) => {
    merged.push(event.kind === "text_delta" ? `text:${event.text}` : event.kind);
  }));
  const result = session.prompt("hello");
  if (result.kind === "turn") {
    await result.turn.steer?.("extra");
    await result.turn.outcome;
  }
  await session.dispose();
  return merged;
}

test("aggregateDeltas merges consecutive deltas and preserves order", async () => {
  assert.deepEqual(await runAggregated(), [
    "turn_started",
    "text:echo:hellosteer:extra",
    "turn_ended",
  ]);
});

async function stallFixture(): Promise<{ stalls: string[]; stop: () => void; dispose: () => Promise<void> }> {
  const { observeStalls } = await import("../packages/oar/src/observe/stall-observer.js");
  const session = await startMockSession(
    { kind: "available", via: "bundled" },
    { cwd: process.cwd() },
  );
  const stalls: string[] = [];
  const stop = observeStalls(session, {
    stallAfterMs: 50,
    onStall: (info) => {
      stalls.push(info.lastEventKind);
    },
  });
  assert.equal(session.prompt("hang").kind, "turn");
  return { stalls, stop, dispose: async () => session.dispose() };
}

test("observeStalls reports a silent active turn (virtual time)", async () => {
  // Date is mocked too: stallOf re-derives silence from the wall clock, so
  // virtual time must advance both the timer AND Date.now().
  vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
  const { stalls, stop, dispose } = await stallFixture();
  vi.advanceTimersByTime(49);
  assert.deepEqual(stalls, [], "must not fire before the threshold");
  vi.advanceTimersByTime(2);
  assert.deepEqual(stalls, ["turn_started"], "fires once past the threshold");
  vi.advanceTimersByTime(500);
  assert.deepEqual(stalls, ["turn_started"], "fires once per silence episode");
  stop();
  await dispose();
});

test("aggregateDeltas maxHoldMs flushes a held block on quiescence (virtual time)", () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const seen: string[] = [];
  const envelope = { sessionId: "s", turnId: "t", seq: 0, receivedAt: 0 };
  const observer = aggregateDeltasSync((event) => {
    seen.push(event.kind === "text_delta" ? event.text : event.kind);
  });
  observer({ ...envelope, kind: "text_delta", text: "a" });
  observer({ ...envelope, kind: "text_delta", text: "b" });
  vi.advanceTimersByTime(99);
  assert.deepEqual(seen, [], "held while the stream is briefly quiet");
  vi.advanceTimersByTime(1);
  assert.deepEqual(seen, ["ab"], "quiescence flush after maxHoldMs");
});

test("reduceStatus follows the documented transition table", async () => {
  const { initialStatus, reduceStatus, stallOf } = await import(
    "../packages/oar/src/observe/agent-status.js"
  );
  const envelope = { sessionId: "s", turnId: "t", seq: 0, receivedAt: 1000 };
  const fold = (events: Parameters<typeof reduceStatus>[1][]): unknown[] => {
    let status = initialStatus;
    const seen: unknown[] = [];
    for (const event of events) {
      status = reduceStatus(status, event);
      seen.push(status.kind === "running" ? status.phase : status.kind);
    }
    return seen;
  };
  assert.deepEqual(fold([
    { ...envelope, kind: "turn_started" },
    { ...envelope, kind: "thinking_delta", text: "…" },
    { ...envelope, kind: "text_delta", text: "hi" },
    { ...envelope, kind: "tool_call_started", callId: "c1", tool: "bash" },
    { ...envelope, kind: "tool_call_ended", callId: "c1" },
    { ...envelope, kind: "turn_ended", outcome: { kind: "completed" } },
  ]), [
    "waiting_model",
    "thinking",
    "responding",
    { tool: "bash", callId: "c1" },
    "waiting_model",
    "idle",
  ]);
  const runningAt = reduceStatus(initialStatus, { ...envelope, kind: "turn_started" });
  assert.deepEqual(stallOf(runningAt, 1400, 500), null);
  assert.deepEqual(stallOf(runningAt, 1600, 500), { turnId: "t", silentForMs: 600 });
  assert.equal(stallOf(initialStatus, 99_999, 1), null);
});

test("resume adopts the runtime-native session identity", async () => {
  const installation = { kind: "available", via: "bundled" } as const;
  const first = await startMockSession(installation, { cwd: process.cwd() });
  const second = await startMockSession(installation, { cwd: process.cwd(), resume: first.id });
  assert.equal(second.id, first.id);
  await first.dispose();
  await second.dispose();
});

test("session.steerOrQueue steers when possible and queues otherwise", async () => {
  const installation = { kind: "available", via: "bundled" } as const;
  const session = await startMockSession(installation, { cwd: process.cwd() });
  const active = session.prompt("one");
  if (active.kind !== "turn") {
    throw new Error("expected turn");
  }
  assert.deepEqual(await session.steerOrQueue(active.turn, "mid"), { landed: "steered" });
  await active.turn.outcome;
  assert.deepEqual(await session.steerOrQueue(active.turn, "late"), { landed: "queued" });
  await session.dispose();
});
