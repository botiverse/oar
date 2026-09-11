import assert from "node:assert/strict";
import { afterEach, expect, test, vi } from "vitest";
import { aggregateDeltas } from "../packages/oar/src/observe/aggregate-events.js";
import { simpleStateOf as simpleStateOfSync } from "../packages/oar/src/observe/observe-agent.js";
import { awaitTurnEnd } from "../packages/oar/src/observe/turns.js";
import type { EventView, SessionObserver, SessionRecord } from "../packages/oar/src/index.js";
import { startMockSession } from "../sea-trial/fixtures/mock-session.js";

const aggregateDeltasSync = (observer: SessionObserver): SessionObserver =>
  aggregateDeltas(observer, { maxHoldMs: 100 });

afterEach(() => {
  vi.useRealTimers();
});

const installation = { kind: "available", via: "bundled" } as const;

/** One line per record: `kind[:detail]`, the compact skeleton the tests assert on. */
function describe(record: SessionRecord): string {
  switch (record.kind) {
    case "request":
      return `request ${record.body.kind}`;
    case "response":
      return `response ${record.body.kind}`;
    case "event":
      return record.body.views.length === 0
        ? `event ${record.body.type}`
        : record.body.views.map((view) => (view.kind === "text_delta" ? `text:${view.text}` : view.kind)).join("+");
    default:
      return "?";
  }
}

async function runAggregated(): Promise<string[]> {
  const session = await startMockSession(installation, { cwd: process.cwd() });
  const merged: string[] = [];
  session.subscribe(aggregateDeltas((record) => {
    merged.push(describe(record));
  }));
  const result = await session.prompt("hello");
  await session.steer("extra");
  await awaitTurnEnd(session, result.request.seq);
  await session.dispose();
  return merged;
}

test("aggregateDeltas merges consecutive deltas and preserves order", async () => {
  expect(await runAggregated()).toMatchInlineSnapshot(`
    [
      "request prompt",
      "response accepted",
      "request steer",
      "response accepted",
      "text:echo:hellosteer:extra",
      "turn_ended+usage",
      "request dispose",
      "response exited",
    ]
  `);
});

async function stallFixture(): Promise<{ stalls: string[]; stop: () => void; dispose: () => Promise<void> }> {
  const { observeStalls } = await import("../packages/oar/src/observe/stall-observer.js");
  const session = await startMockSession(installation, { cwd: process.cwd() });
  const stalls: string[] = [];
  const stop = observeStalls(session, {
    stallAfterMs: 50,
    onStall: (info) => {
      stalls.push(info.lastRecordKind);
    },
  });
  const started = await session.prompt("hang");
  assert.equal(started.response.body.kind, "accepted");
  return { stalls, stop, dispose: async () => session.dispose() };
}

test("observeStalls reports a silent active turn (virtual time)", async () => {
  // Date is mocked too: stallOf re-derives silence from the wall clock, so
  // virtual time must advance both the timer AND Date.now().
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const { stalls, stop, dispose } = await stallFixture();
  vi.advanceTimersByTime(49);
  assert.deepEqual(stalls, [], "must not fire before the threshold");
  vi.advanceTimersByTime(2);
  assert.deepEqual(stalls, ["response"], "fires once past the threshold (last record: the accepted response)");
  vi.advanceTimersByTime(500);
  assert.deepEqual(stalls, ["response"], "fires once per silence episode");
  stop();
  await dispose();
});

let seqCounter = 0;
function event(views: EventView[], overrides: { agentPath?: readonly string[]; seq?: number; receivedAt?: number } = {}): SessionRecord {
  seqCounter += 1;
  return {
    sessionId: "s",
    agentPath: overrides.agentPath ?? [],
    seq: overrides.seq ?? seqCounter,
    receivedAt: overrides.receivedAt ?? 0,
    kind: "event",
    body: { type: "fixture", native: null, views },
  };
}

test("aggregateDeltas maxHoldMs flushes a held block on quiescence (virtual time)", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const seen: string[] = [];
  const observer = aggregateDeltasSync((record) => {
    seen.push(describe(record));
  });
  observer(event([{ kind: "text_delta", text: "a" }]));
  observer(event([{ kind: "text_delta", text: "b" }]));
  vi.advanceTimersByTime(99);
  assert.deepEqual(seen, [], "held while the stream is briefly quiet");
  vi.advanceTimersByTime(1);
  assert.deepEqual(seen, ["text:ab"], "quiescence flush after maxHoldMs");
});

test("aggregateDeltas merges readable reasoning without swallowing redaction, per agent", () => {
  const seen: string[] = [];
  const observer = aggregateDeltas((record) => {
    const view = record.kind === "event" ? record.body.views[0] : undefined;
    const text = view?.kind === "reasoning" && view.content.kind === "text" ? view.content.text : (view?.kind ?? record.kind);
    seen.push(`${record.agentPath.join("/") || "root"}:${text}`);
  });
  observer(event([{ kind: "reasoning", content: { kind: "text", text: "read" } }]));
  observer(event([{ kind: "reasoning", content: { kind: "text", text: "ing" } }]));
  observer(event([{ kind: "reasoning", content: { kind: "text", text: "child" } }], { agentPath: ["a1"] }));
  observer(event([{ kind: "reasoning", content: { kind: "redacted" } }]));
  observer(event([{ kind: "text_delta", text: "x" }, { kind: "tool_call_started", callId: "c", tool: "t" }]));
  assert.deepEqual(seen, ["root:reading", "a1:child", "root:reasoning", "root:text_delta"]);
});

const promptRecord: SessionRecord = { sessionId: "s", agentPath: [], seq: 0, receivedAt: 1000, kind: "request", id: "rq", direction: "toRuntime", body: { kind: "prompt", input: "hi" } };

test("reduceStatus follows the documented transition table", async () => {
  const { initialStatus, reduceStatus } = await import("../packages/oar/src/observe/agent-status.js");
  const fold = (records: SessionRecord[]): unknown[] => {
    let status = initialStatus;
    const seen: unknown[] = [];
    for (const record of records) {
      status = reduceStatus(status, record);
      seen.push(status.kind === "running" ? status.phase : status.kind);
    }
    return seen;
  };
  expect(fold([
    promptRecord,
    event([{ kind: "reasoning", content: { kind: "redacted" } }]),
    event([{ kind: "text_delta", text: "hi" }]),
    event([{ kind: "tool_call_started", callId: "c1", tool: "bash" }]),
    event([{ kind: "tool_call_ended", callId: "c1" }], { agentPath: ["child"] }),
    event([{ kind: "tool_call_ended", callId: "c1" }]),
    event([{ kind: "turn_ended", outcome: { kind: "completed" } }]),
  ])).toMatchInlineSnapshot(`
    [
      "waiting_model",
      "thinking",
      "responding",
      {
        "callId": "c1",
        "tool": "bash",
      },
      {
        "callId": "c1",
        "tool": "bash",
      },
      "waiting_model",
      "idle",
    ]
  `);
});

test("reduceStatus: stall, rejected prompt, and exit leave running", async () => {
  const { initialStatus, reduceStatus, stallOf } = await import("../packages/oar/src/observe/agent-status.js");
  const runningAt = reduceStatus(initialStatus, promptRecord);
  assert.deepEqual(stallOf(runningAt, 1400, 500), null);
  assert.deepEqual(stallOf(runningAt, 1600, 500), { sinceSeq: 0, silentForMs: 600 });
  assert.equal(stallOf(initialStatus, 99_999, 1), null);
  const rejected: SessionRecord = { sessionId: "s", agentPath: [], seq: 1, receivedAt: 1001, kind: "response", requestId: "rq", body: { kind: "rejected", reason: "busy" } };
  assert.deepEqual(reduceStatus(runningAt, rejected), { kind: "idle" }, "a rejected prompt never became a turn");
  const exited: SessionRecord = { sessionId: "s", agentPath: [], seq: 2, receivedAt: 1002, kind: "response", requestId: "", body: { kind: "exited", code: 1 } };
  assert.equal(reduceStatus(runningAt, exited).kind, "idle");
});

test("resume adopts the runtime-native session identity", async () => {
  const first = await startMockSession(installation, { cwd: process.cwd() });
  const second = await startMockSession(installation, { cwd: process.cwd(), resume: first.id });
  assert.equal(second.id, first.id);
  await first.dispose();
  await second.dispose();
});

test("session.steerOrQueue steers when possible and queues otherwise", async () => {
  const session = await startMockSession(installation, { cwd: process.cwd() });
  const active = await session.prompt("one");
  const mid = await session.steerOrQueue("mid");
  assert.equal(mid.landed, "steered");
  await awaitTurnEnd(session, active.request.seq);
  const late = await session.steerOrQueue("late");
  assert.equal(late.landed, "queued");
  await session.dispose();
});

async function virtualTimeSession(): Promise<Awaited<ReturnType<typeof startMockSession>>> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const session = await startMockSession(installation, { cwd: process.cwd() });
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
  void session.prompt("hang");
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
    status: { kind: "running", sinceSeq: 0, phase: "thinking", lastEventAt: 0 },
    stall: null,
  } as const;
  assert.equal(simpleStateOfSync(running), "busy");
  const failedIdle = {
    status: { kind: "idle", lastTurnOutcome: { kind: "failed", reason: "boom", failure: "unknown" } },
    stall: null,
  } as const;
  assert.equal(simpleStateOfSync(failedIdle), "error");
  const stuckBeatsBusy = { ...running, stall: { sinceSeq: 0, silentForMs: 99 } };
  assert.equal(simpleStateOfSync(stuckBeatsBusy), "stuck");
});
