import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { Session } from "../packages/oar/src/contracts/session.js";
import { observeStalls } from "../packages/oar/src/observe/stall-observer.js";
import { startMockSession } from "../sea-trial/fixtures/mock-session.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async cleanup => { await cleanup(); }));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function stallFixture(stallAfterMs = 50): Promise<{ session: Session; stalls: string[]; stop: () => void }> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(1000);
  const session = await startMockSession({ kind: "available", via: "bundled" }, { cwd: process.cwd() });
  const stalls: string[] = [];
  const stop = observeStalls(session, { stallAfterMs, onStall: info => { stalls.push(info.lastRecordKind); } });
  cleanups.push(async () => { stop(); await session.dispose(); });
  const started = await session.prompt("hang");
  assert.equal(started.response.body.kind, "accepted");
  return { session, stalls, stop };
}

type Fixture = Awaited<ReturnType<typeof stallFixture>>;

function expectStallsAfter(ms: number, stalls: readonly string[], expected: readonly string[]): void {
  vi.advanceTimersByTime(ms);
  assert.deepEqual(stalls, expected);
}

async function restart(session: Session): Promise<void> {
  await session.abort();
  const next = await session.prompt("hang");
  assert.equal(next.response.body.kind, "accepted");
}

async function finishFixture({ session, stop }: Fixture, action: "abort" | "dispose" | "unsubscribe"): Promise<void> {
  if (action === "abort") { await session.abort(); }
  else if (action === "dispose") { await session.dispose(); }
  else { stop(); }
}

test("observeStalls reports a silent active turn once per episode (virtual time)", async () => {
  const { stalls } = await stallFixture();
  expectStallsAfter(49, stalls, []);
  expectStallsAfter(2, stalls, ["response"]);
  expectStallsAfter(500, stalls, ["response"]);
  assert.equal(vi.getTimerCount(), 0);
});

test.each([1, 20])("observeStalls retries the remaining time when its timer fires %i ms early", async (earlyBy) => {
  const { stalls } = await stallFixture();
  // Move the wall clock independently of the timer's remaining delay.
  vi.setSystemTime(1000 - earlyBy);
  expectStallsAfter(50, stalls, []);
  expectStallsAfter(earlyBy - 1, stalls, []);
  expectStallsAfter(1, stalls, ["response"]);
  expectStallsAfter(500, stalls, ["response"]);
  assert.equal(vi.getTimerCount(), 0);
});

test("observeStalls gives a fractional remaining delay a positive timer interval", async () => {
  const { stalls } = await stallFixture(50.25);
  expectStallsAfter(50, stalls, []);
  expectStallsAfter(1, stalls, ["response"]);
  assert.equal(vi.getTimerCount(), 0);
});

test.each(["abort", "dispose", "unsubscribe"] as const)("observeStalls cancels an early retry on %s", async (action) => {
  const fixture = await stallFixture();
  vi.setSystemTime(999);
  expectStallsAfter(50, fixture.stalls, []);
  assert.equal(vi.getTimerCount(), 1, "the early callback left a pending retry");
  await finishFixture(fixture, action);
  assert.equal(vi.getTimerCount(), 0);
  expectStallsAfter(500, fixture.stalls, []);
});

test("observeStalls re-arms for the next turn after reporting an early-timer episode", async () => {
  const { session, stalls } = await stallFixture();
  vi.setSystemTime(999);
  expectStallsAfter(51, stalls, ["response"]);
  await restart(session);
  expectStallsAfter(49, stalls, ["response"]);
  expectStallsAfter(1, stalls, ["response", "response"]);
  expectStallsAfter(500, stalls, ["response", "response"]);
  assert.equal(vi.getTimerCount(), 0);
});

test.each([Number.NaN, Number.POSITIVE_INFINITY])("observeStalls does not retry an unreachable threshold (%s)", async (threshold) => {
  const { stalls } = await stallFixture(threshold);
  expectStallsAfter(500, stalls, []);
  assert.equal(vi.getTimerCount(), 0, "a null stall with no finite remaining interval must not poll");
});

test("observeStalls does not poll when its remaining delay exceeds the timer limit", async () => {
  const { stalls } = await stallFixture(2_147_484_647);
  const clock = vi.spyOn(Date, "now");
  expectStallsAfter(500, stalls, []);
  assert.equal(clock.mock.calls.length, 1, "overflowing the timer range must not create millisecond polling");
  assert.equal(vi.getTimerCount(), 1, "the long finite interval still has a future check");
});
