import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startMockSession } from "../drydock/mock-session.js";
import { runtimeUnderTest } from "../drydock/runner.js";
import { runSuite } from "../sea-trial/runner.js";
import { sessionCases } from "../sea-trial/cases/session.js";
import { defineRuntime } from "../packages/oar/src/index.js";

const mockRuntime = defineRuntime({
  id: "mock",
  installation: async () => ({ kind: "available" as const, via: "bundled" as const }),
  session: startMockSession,
});

test("mock runtime passes every shared session behavior case", async () => {
  const outcomes = await runSuite(sessionCases, runtimeUnderTest(mockRuntime));
  assert.deepEqual(
    outcomes.map((outcome) => outcome.kind),
    sessionCases.map(() => "pass"),
    JSON.stringify(outcomes),
  );
});

async function runAggregated(): Promise<string[]> {
  const { aggregateDeltas } = await import("../packages/oar/src/shared/aggregate-events.js");
  const session = await startMockSession(
    { kind: "available", via: "bundled" },
    { cwd: process.cwd() },
  );
  const merged: string[] = [];
  session.subscribe(aggregateDeltas((event) => {
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

test("observeStalls reports a silent active turn", async () => {
  const { observeStalls } = await import("../packages/oar/src/shared/stall-observer.js");
  const session = await startMockSession(
    { kind: "available", via: "bundled" },
    { cwd: process.cwd() },
  );
  const stalls: string[] = [];
  const stop = observeStalls(session, {
    stallAfterMs: 50,
    onStall: (info) => {
      stalls.push(`${info.lastEventKind}:${info.silentForMs >= 50}`);
    },
  });
  const result = session.prompt("hang");
  assert.equal(result.kind, "turn");
  await delay(150);
  assert.deepEqual(stalls, ["turn_started:true"]);
  stop();
  await session.dispose();
});

test("reduceStatus follows the documented transition table", async () => {
  const { initialStatus, reduceStatus, stallOf } = await import(
    "../packages/oar/src/shared/agent-status.js"
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
