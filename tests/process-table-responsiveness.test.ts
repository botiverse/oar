import { monitorEventLoopDelay } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, test } from "vitest";
import { observeProcessTableOnce } from "../packages/oar/src/shared/executable/process-table-async.js";

async function observedYield(): Promise<boolean> {
  let finished = false;
  const heartbeat = async (): Promise<boolean> => { await nextTurn(); return !finished; };
  const tick = heartbeat();
  const result = await observeProcessTableOnce("procfs");
  finished = true;
  expect(result.ok).toBe(true);
  if (result.ok) { expect(result.table.has(process.pid)).toBe(true); }
  return tick;
}

// No substituted table reader or filesystem. A synchronous procfs implementation
// runs every read before the first setImmediate, even if each read is fast.
// oxlint-disable-next-line eslint/max-statements -- Measure and check all observations within one monitor lifetime.
test.skipIf(process.platform !== "linux")("real procfs observations yield to the host and keep event-loop delay bounded", async () => {
  const latency = monitorEventLoopDelay({ resolution: 1 });
  latency.enable();
  let yielded = 0;
  try {
    await nextTurn();
    for (let index = 0; index < 20; index += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Consecutive real reads must each yield, not hide one blocking read behind another.
      if (await observedYield()) { yielded += 1; }
    }
    expect(yielded).toBe(20);
    expect(latency.max / 1e6, "real procfs maximum event-loop delay (ms)").toBeLessThan(1000);
  } finally { latency.disable(); }
});
