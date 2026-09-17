import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import type { ControlResult, Session } from "../packages/oar/src/contracts/session.js";
import { observeAgent, simpleStateOf, type AgentObserver } from "../packages/oar/src/observe/observe-agent.js";
import { observeStalls, type StallInfo } from "../packages/oar/src/observe/stall-observer.js";
import { startMockSession } from "../sea-trial/fixtures/mock-session.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function newSession(): Promise<Session> {
  const session = await startMockSession({ kind: "available", via: "bundled" }, { cwd: process.cwd() });
  onTestFinished(async () => { await session.dispose(); });
  return session;
}

async function silentSession(elapsedMs: number): Promise<{ session: Session; started: ControlResult }> {
  const session = await newSession();
  const started = await session.prompt("hang");
  vi.advanceTimersByTime(elapsedMs);
  return { session, started };
}

function watchAgent(session: Session): { observer: AgentObserver; states: string[] } {
  const observer = observeAgent(session, { stallAfterMs: 50, tickMs: 1 });
  const states: string[] = [];
  observer.subscribe((view) => { states.push(simpleStateOf(view)); });
  onTestFinished(() => { observer.dispose(); });
  return { observer, states };
}

function watchStalls(session: Session): { stop: () => void; stalls: StallInfo[] } {
  const stalls: StallInfo[] = [];
  const stop = observeStalls(session, { stallAfterMs: 50, onStall: (info) => { stalls.push(info); } });
  onTestFinished(stop);
  return { stop, stalls };
}

test.each([20, 80])("observeAgent reconstructs an active turn after %i ms", async (elapsedMs) => {
  const { session } = await silentSession(elapsedMs);
  const { states } = watchAgent(session);
  expect(states).toEqual([elapsedMs < 50 ? "busy" : "stuck"]);
  vi.advanceTimersByTime(50);
  expect(states.at(-1)).toBe("stuck");
  await session.abort();
  expect(states.at(-1)).toBe("idle");
});

test.each([
  { elapsedMs: 20, remainingMs: 30 },
  { elapsedMs: 80, remainingMs: 0 },
])("observeStalls keeps the deadline after attaching $elapsedMs ms late", async ({ elapsedMs, remainingMs }) => {
  const { session, started } = await silentSession(elapsedMs);
  const { stalls } = watchStalls(session);
  expect(stalls).toHaveLength(0);
  if (remainingMs > 0) {
    vi.advanceTimersByTime(remainingMs - 1);
    expect(stalls).toHaveLength(0);
  }
  vi.advanceTimersByTime(remainingMs === 0 ? 0 : 1);
  expect(stalls).toEqual([{
    sinceSeq: started.request.seq,
    silentForMs: elapsedMs + remainingMs,
    lastRecordKind: "response",
  }]);
});

test("a late stall observer reports each silence episode once", async () => {
  const { session } = await silentSession(80);
  const { stalls } = watchStalls(session);
  vi.advanceTimersByTime(500);
  expect(stalls).toHaveLength(1);
  await session.abort();
  const next = await session.prompt("hang");
  vi.advanceTimersByTime(50);
  expect(stalls).toHaveLength(2);
  expect(stalls[1]?.sinceSeq).toBe(next.request.seq);
});

async function inactiveSession(outcome: "completed" | "aborted" | "rejected"): Promise<Session> {
  const session = await newSession();
  if (outcome === "rejected") {
    await session.dispose();
    await session.prompt("hang");
  } else {
    await session.prompt(outcome === "completed" ? "hello" : "hang");
    await (outcome === "completed" ? vi.advanceTimersByTimeAsync(10) : session.abort());
  }
  vi.advanceTimersByTime(80);
  return session;
}

test.each(["completed", "aborted", "rejected"] as const)("late observers remain idle when the turn was %s", async (outcome) => {
  const session = await inactiveSession(outcome);
  const { states } = watchAgent(session);
  const { stalls } = watchStalls(session);
  vi.advanceTimersByTime(100);
  expect(states).toEqual(["idle"]);
  expect(stalls).toHaveLength(0);
});

test("late observers can be disposed before an overdue stall is delivered", async () => {
  const { session } = await silentSession(80);
  const { observer } = watchAgent(session);
  const { stop, stalls } = watchStalls(session);
  stop();
  observer.dispose();
  vi.advanceTimersByTime(100);
  expect(stalls).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});
