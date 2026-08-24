import assert from "node:assert/strict";
import { afterEach, expect, test, vi } from "vitest";
import { aggregateDeltas } from "../packages/oar/src/observe/aggregate-events.js";
import { simpleStateOf as simpleStateOfSync } from "../packages/oar/src/observe/observe-agent.js";
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
  expect(await runAggregated()).toMatchInlineSnapshot(`
    [
      "turn_started",
      "text:echo:hellosteer:extra",
      "turn_ended",
    ]
  `);
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

test("aggregateDeltas merges readable reasoning without swallowing redaction", () => {
  const seen: unknown[] = [];
  const envelope = { sessionId: "s", turnId: "t", receivedAt: 0 };
  const observer = aggregateDeltas((event) => {
    seen.push(event);
  });
  observer({ ...envelope, seq: 1, kind: "reasoning", content: { kind: "text", text: "read" } });
  observer({ ...envelope, seq: 2, kind: "reasoning", content: { kind: "text", text: "ing" } });
  observer({ ...envelope, seq: 3, kind: "reasoning", content: { kind: "redacted" } });

  expect(seen).toMatchInlineSnapshot(`
    [
      {
        "content": {
          "kind": "text",
          "text": "reading",
        },
        "kind": "reasoning",
        "receivedAt": 0,
        "seq": 2,
        "sessionId": "s",
        "turnId": "t",
      },
      {
        "content": {
          "kind": "redacted",
        },
        "kind": "reasoning",
        "receivedAt": 0,
        "seq": 3,
        "sessionId": "s",
        "turnId": "t",
      },
    ]
  `);
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
  expect(fold([
    { ...envelope, kind: "turn_started" },
    { ...envelope, kind: "reasoning", content: { kind: "redacted" } },
    { ...envelope, kind: "text_delta", text: "hi" },
    { ...envelope, kind: "tool_call_started", callId: "c1", tool: "bash" },
    { ...envelope, kind: "tool_call_ended", callId: "c1" },
    { ...envelope, kind: "turn_ended", outcome: { kind: "completed" } },
  ])).toMatchInlineSnapshot(`
    [
      "waiting_model",
      "thinking",
      "responding",
      {
        "callId": "c1",
        "tool": "bash",
      },
      "waiting_model",
      "idle",
    ]
  `);
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

async function virtualTimeSession(): Promise<Awaited<ReturnType<typeof startMockSession>>> {
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
  const session = await startMockSession(
    { kind: "available", via: "bundled" },
    { cwd: process.cwd() },
  );
  return session;
}

async function observedStates(): Promise<string[]> {
  const { observeAgent, simpleStateOf } = await import("../packages/oar/src/observe/observe-agent.js");
  const session = await virtualTimeSession();
  const observer = observeAgent(session, { stallAfterMs: 50 });
  const states: string[] = [];
  observer.subscribe((view) => {
    states.push(simpleStateOf(view));
  });
  session.prompt("hang");
  await vi.advanceTimersByTimeAsync(2000);
  observer.dispose();
  await session.dispose();
  return states;
}

test("observeAgent unifies fold and stall into one view stream", async () => {
  const states = await observedStates();
  assert.equal(states[0], "idle", "initial view pushed on subscribe");
  assert.equal(states[1], "busy");
  assert.equal(states.at(-1), "stuck", "silence past threshold flips the view once");
  assert.ok(!states.slice(states.indexOf("stuck")).includes("busy"), "no flapping while silent");
});

test("simpleStateOf reports error only as idle-after-failure", () => {
  const running = {
    status: { kind: "running", turnId: "t", phase: "thinking", lastEventAt: 0 },
    stall: null,
  } as const;
  assert.equal(simpleStateOfSync(running), "busy");
  const failedIdle = {
    status: { kind: "idle", lastTurnOutcome: { kind: "failed", reason: "boom", failure: "unknown" } },
    stall: null,
  } as const;
  assert.equal(simpleStateOfSync(failedIdle), "error");
  const stuckBeatsBusy = { ...running, stall: { turnId: "t", silentForMs: 99 } };
  assert.equal(simpleStateOfSync(stuckBeatsBusy), "stuck");
});
