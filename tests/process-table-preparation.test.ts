import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ProcessTableObservation } from "../packages/oar/src/shared/executable/process-tree.js";

beforeEach(() => { vi.resetModules(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

// oxlint-disable-next-line eslint/max-statements -- Real batching must separate preparation from shutdown evidence requested after its query began.
test("once-only preparation is nonblocking and never supplies shutdown's identity snapshot", async () => {
  const tables = await import("../packages/oar/src/shared/executable/process-table-async.js");
  vi.spyOn(tables, "processTableSource").mockReturnValue("windows");
  const old = Promise.withResolvers<ProcessTableObservation>();
  const success: ProcessTableObservation = { ok: true, source: "windows", elapsedMs: 1, skipped: 2, table: new Map() };
  const query = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(success);
  const batch = tables.batchProcessTableReads(query);
  vi.spyOn(tables, "observeProcessTableAsync").mockImplementation(async source => { const result = await batch(source ?? "windows"); return result; });
  const preparation = await import("../packages/oar/src/shared/executable/process-table-preparation.js");
  preparation.prepareProcessTable(); preparation.prepareProcessTable();
  expect(preparation.processTablePreparation()).toEqual({ status: "pending" });
  await vi.advanceTimersByTimeAsync(0); expect(query).toHaveBeenCalledOnce();
  const cleanupRead = tables.observeProcessTableAsync();
  await vi.advanceTimersByTimeAsync(0); expect(query).toHaveBeenCalledOnce();
  old.resolve(success); await cleanupRead;
  expect(query).toHaveBeenCalledTimes(2);
  expect(preparation.processTablePreparation()).toEqual({ ok: true, source: "windows", elapsedMs: 1, skipped: 2 });
  preparation.prepareProcessTable(); expect(query).toHaveBeenCalledTimes(2);
});

// oxlint-disable-next-line eslint/max-statements -- Retain failure after the delayed successful query arrives.
test("failed preparation is bounded, retains metadata only and is never retried", async () => {
  const tables = await import("../packages/oar/src/shared/executable/process-table-async.js");
  vi.spyOn(tables, "processTableSource").mockReturnValue("windows");
  const gate = Promise.withResolvers<ProcessTableObservation>();
  const read = vi.spyOn(tables, "observeProcessTableAsync").mockReturnValue(gate.promise);
  const preparation = await import("../packages/oar/src/shared/executable/process-table-preparation.js");
  preparation.prepareProcessTable(); await vi.advanceTimersByTimeAsync(5000);
  const diagnostic = { ok: false, source: "windows", reason: "timeout", timeoutMs: 5000, elapsedMs: 5000 };
  expect(preparation.processTablePreparation()).toEqual(diagnostic);
  gate.resolve({ ok: true, source: "windows", elapsedMs: 6000, skipped: 0, table: new Map() });
  await vi.advanceTimersByTimeAsync(1); preparation.prepareProcessTable();
  expect(read).toHaveBeenCalledOnce();
  expect(preparation.processTablePreparation()).toEqual(diagnostic);
});

test("other platforms perform no preparation", async () => {
  const tables = await import("../packages/oar/src/shared/executable/process-table-async.js");
  vi.spyOn(tables, "processTableSource").mockReturnValue("procfs");
  const read = vi.spyOn(tables, "observeProcessTableAsync");
  const preparation = await import("../packages/oar/src/shared/executable/process-table-preparation.js");
  preparation.prepareProcessTable();
  expect(read).not.toHaveBeenCalled();
  expect(preparation.processTablePreparation()).toBeUndefined();
});
