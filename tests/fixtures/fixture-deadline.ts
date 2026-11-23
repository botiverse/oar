import assert from "node:assert/strict";
import { eventually } from "./process-tree.js";
import { onTestFinished, vi } from "vitest";

/** Let a real child publish its identity before starting the caller's deadline.
 * Readiness polling uses node:timers/promises and performance.now(). Once
 * released, both the original timeout and subsequent cleanup timers tick.
 */
export function holdFixtureDeadline(): () => void {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  onTestFinished(() => { vi.useRealTimers(); });
  return () => { vi.setTimerTickMode("interval"); };
}

/** Join the operation even when its fixture fails to reach the intended stage. */
export async function withFixtureDeadline<T>(ready: () => boolean, operation: () => Promise<T>): Promise<T> {
  const startClock = holdFixtureDeadline();
  const [outcome, readiness] = await Promise.allSettled([operation(), eventually(ready, 10_000).finally(startClock)]);
  if (readiness.status === "rejected") { throw readiness.reason; }
  assert.ok(readiness.value, "The fixture never published readiness");
  if (outcome.status === "rejected") { throw outcome.reason; }
  return outcome.value;
}
