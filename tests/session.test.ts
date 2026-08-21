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
