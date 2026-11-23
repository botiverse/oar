import assert from "node:assert/strict";
import { onTestFinished, vi } from "vitest";
import { eventually } from "./process-tree.js";

/** Hold the caller's deadline during real child startup. Always release it
 * when readiness settles. On a failed setup, join the operation before the
 * error can reach test teardown and discard its timers.
 */
export function holdFixtureDeadline(hold = true) {
  if (hold) {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    onTestFinished(() => { vi.useRealTimers(); });
  }
  // oxlint-disable-next-line max-statements -- Release the clock and join the same operation on every readiness failure.
  return async function waitForFixture<T>(pending: Promise<unknown>, ready: () => Promise<T>, controller?: AbortController): Promise<T> {
    const finished = Promise.allSettled([pending]);
    let prepared = false;
    try {
      const value = await ready();
      prepared = true;
      return value;
    } finally {
      if (hold) { vi.setTimerTickMode("interval"); }
      if (!prepared) {
        controller?.abort();
        await finished;
        // A probe may return when its pipes close, before its force-kill timer.
        if (hold) { await vi.runOnlyPendingTimersAsync(); }
      }
    }
  };
}

export async function withFixtureDeadline<T>(ready: () => boolean, operation: () => Promise<T>): Promise<T> {
  const waitForFixture = holdFixtureDeadline();
  const pending = operation();
  await waitForFixture(pending, async () => {
    assert.ok(await eventually(ready, 10_000), "The fixture never published readiness");
  });
  return pending;
}
