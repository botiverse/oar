import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ProcessEntry, ProcessTableObservation } from "../packages/oar/src/shared/executable/process-tree.js";

beforeEach(() => { vi.resetModules(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const snapshot = (entries: readonly ProcessEntry[]): ProcessTableObservation => ({
  ok: true, source: "windows", elapsedMs: 1, skipped: 0, table: new Map(entries.map(entry => [entry.pid, entry])),
});

// oxlint-disable-next-line eslint/max-statements -- Real batching must separate preparation from shutdown evidence requested after its query began.
test("once-only preparation is nonblocking and never supplies shutdown's identity snapshot", async () => {
  const tables = await import("../packages/oar/src/shared/executable/process-table-async.js");
  vi.spyOn(tables, "processTableSource").mockReturnValue("windows");
  const old = Promise.withResolvers<ProcessTableObservation>();
  const success: ProcessTableObservation = { ok: true, source: "windows", elapsedMs: 1, skipped: 2, table: new Map() };
  const query = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(success);
  const batch = tables.batchProcessTableReads(query);
  vi.spyOn(tables, "observeProcessTableAsync").mockImplementation(async (source, options) => { const result = await batch(source ?? "windows", options); return result; });
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

// oxlint-disable-next-line eslint/max-statements -- Complete preparation first, then capture different descendants and revalidate both as orphaned identities.
test("completed preparation cannot replace the next capture or authorize signals for its old descendants", async () => {
  const tables = await import("../packages/oar/src/shared/executable/process-table-async.js");
  const tree = await import("../packages/oar/src/shared/executable/process-tree.js");
  vi.spyOn(tables, "processTableSource").mockReturnValue("windows");
  const root = { pid: 123, ppid: process.pid, pgid: 0, start: "2026-10-31T00:00:00Z" };
  const old = { pid: 456, ppid: root.pid, pgid: 0, start: "2026-10-31T00:00:01Z" };
  const current = { pid: 789, ppid: root.pid, pgid: 0, start: "2026-10-31T00:00:02Z" };
  const final = snapshot([{ ...old, ppid: 0 }, { ...current, ppid: 0 }]);
  const query = vi.fn().mockResolvedValueOnce(snapshot([root, old])).mockResolvedValueOnce(snapshot([root, current])).mockResolvedValue(final);
  const batch = tables.batchProcessTableReads(query);
  vi.spyOn(tables, "observeProcessTableAsync").mockImplementation(async (source, options) => { const result = await batch(source ?? "windows", options); return result; });
  const preparation = await import("../packages/oar/src/shared/executable/process-table-preparation.js");
  preparation.prepareProcessTable(); await vi.advanceTimersByTimeAsync(0);
  expect(query).toHaveBeenCalledOnce();
  expect(preparation.processTablePreparation()).toEqual({ ok: true, source: "windows", elapsedMs: 1, skipped: 0 });
  const { processTreeCleanup } = await import("../packages/oar/src/shared/executable/process-cleanup.js");
  const kill = vi.spyOn(tree, "killEntries").mockImplementation(() => {});
  const cleanup = processTreeCleanup(root.pid);
  await cleanup.capture(); expect(query).toHaveBeenCalledTimes(2);
  await cleanup.finish(); expect(query).toHaveBeenCalledTimes(3);
  expect(kill).toHaveBeenCalledExactlyOnceWith([current], final.ok ? final.table : undefined);
});
