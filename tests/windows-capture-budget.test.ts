import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { processTreeCleanup } from "../packages/oar/src/shared/executable/process-cleanup.js";
import { observeBeforeCancellation } from "../packages/oar/src/shared/executable/process-cancellation.js";
// oxlint-disable-next-line import/no-namespace -- Control query timing without replacing cleanup or its caller budget.
import * as reads from "../packages/oar/src/shared/executable/process-table-async.js";
// oxlint-disable-next-line import/no-namespace -- Prevent actual signals and verify identity acceptance.
import * as tree from "../packages/oar/src/shared/executable/process-tree.js";

const root = { pid: 123, ppid: process.pid, pgid: 0, start: "2026-10-31T00:00:00Z" };
const tool = { pid: 456, ppid: root.pid, pgid: 0, start: "2026-10-31T00:00:01Z" };
const snapshot: tree.ProcessTableObservation = { ok: true, source: "windows", elapsedMs: 1, skipped: 0, table: new Map([root, tool].map(entry => [entry.pid, entry])) };
const invalid: tree.ProcessTableObservation = { ok: false, source: "windows", reason: "command_failed", elapsedMs: 4000, exitCode: 1 };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.spyOn(reads, "processTableSource").mockReturnValue("windows");
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

// oxlint-disable-next-line eslint/max-statements -- An actual serial batch must count prior-query waiting against the caller's total budget.
test("five seconds includes the prior batch and discards a successful late identity snapshot", async () => {
  const previous = Promise.withResolvers<tree.ProcessTableObservation>();
  const own = Promise.withResolvers<tree.ProcessTableObservation>();
  const query = vi.fn().mockReturnValueOnce(previous.promise).mockReturnValueOnce(own.promise);
  const batched = reads.batchProcessTableReads(query);
  const earlier = batched("windows"); await Promise.resolve();
  vi.spyOn(reads, "observeProcessTableAsync").mockImplementation(async source => { const result = await batched(source ?? "windows"); return result; });
  const kill = vi.spyOn(tree, "killEntries").mockImplementation(() => {});
  const cleanup = processTreeCleanup(root.pid);
  const pending = cleanup.capture();
  await vi.advanceTimersByTimeAsync(4000);
  expect(query).toHaveBeenCalledOnce();
  previous.resolve(invalid); await earlier;
  await vi.advanceTimersByTimeAsync(1000); await pending;
  expect(query).toHaveBeenCalledTimes(2);
  expect(cleanup.diagnostics()).toEqual({ status: "unverified", observations: [
    { ok: false, source: "windows", reason: "timeout", timeoutMs: 5000, elapsedMs: 5000, phase: "before_eof" },
  ] });
  own.resolve(snapshot); await vi.advanceTimersByTimeAsync(1); await cleanup.finish();
  expect(query).toHaveBeenCalledTimes(2);
  expect(kill).not.toHaveBeenCalled();
  expect(cleanup.diagnostics().observations).toHaveLength(1);
});

test("a query timeout does not start an immediate retry", async () => {
  const read = vi.spyOn(reads, "observeProcessTableAsync").mockResolvedValue({ ok: false, source: "windows", reason: "timeout", elapsedMs: 4999, timeoutMs: 5000 });
  const cleanup = processTreeCleanup(root.pid);
  await cleanup.capture();
  expect(read).toHaveBeenCalledOnce();
  expect(cleanup.diagnostics().status).toBe("unverified");
});

// oxlint-disable-next-line eslint/max-statements -- Two observations share one deadline and the late reply cannot change it.
test("a non-timeout retry has only the remainder of the original budget", async () => {
  const first = Promise.withResolvers<tree.ProcessTableObservation>();
  const late = Promise.withResolvers<tree.ProcessTableObservation>();
  const read = vi.spyOn(reads, "observeProcessTableAsync").mockReturnValueOnce(first.promise).mockReturnValueOnce(late.promise);
  const cleanup = processTreeCleanup(root.pid);
  const pending = cleanup.capture();
  await vi.advanceTimersByTimeAsync(4000); first.resolve(invalid);
  await vi.advanceTimersByTimeAsync(1000); await pending;
  expect(read).toHaveBeenCalledTimes(2);
  expect(cleanup.diagnostics()).toEqual({ status: "unverified", observations: [
    { ...invalid, phase: "before_eof" },
    { ok: false, source: "windows", reason: "timeout", timeoutMs: 1000, elapsedMs: 1000, phase: "before_eof" },
  ] });
  late.resolve(snapshot); await vi.advanceTimersByTimeAsync(1);
  expect(cleanup.diagnostics().observations).toHaveLength(2);
});

test("a retry within the budget captures and revalidates descendants normally", async () => {
  const read = vi.spyOn(reads, "observeProcessTableAsync").mockResolvedValueOnce(invalid).mockResolvedValue(snapshot);
  const kill = vi.spyOn(tree, "killEntries").mockImplementation(() => {});
  const cleanup = processTreeCleanup(root.pid);
  await cleanup.capture(); await cleanup.finish();
  expect(read).toHaveBeenCalledTimes(3);
  expect(kill).toHaveBeenCalledWith([tool], snapshot.table);
  expect(cleanup.diagnostics().status).toBe("observed");
});

test("root exit during an unsuccessful observation prevents retry", async () => {
  let alive = true;
  const first = Promise.withResolvers<tree.ProcessTableObservation>();
  const read = vi.spyOn(reads, "observeProcessTableAsync").mockReturnValue(first.promise);
  const cleanup = processTreeCleanup(root.pid, () => alive);
  const pending = cleanup.capture(); alive = false; first.resolve(invalid); await pending;
  expect(read).toHaveBeenCalledOnce();
  expect(cleanup.diagnostics().status).toBe("unverified");
});

// oxlint-disable-next-line eslint/max-statements -- Expiry must both stop the root and prevent a later identity result from signalling tools.
test.each(["force", "finish"])("%s has its own five-second total budget and discards late evidence", async phase => {
  const gate = Promise.withResolvers<tree.ProcessTableObservation>();
  const read = vi.spyOn(reads, "observeProcessTableAsync").mockReturnValue(gate.promise);
  const kill = vi.spyOn(tree, "killEntries").mockImplementation(() => {});
  const stop = vi.fn<() => void>();
  const cleanup = processTreeCleanup(root.pid);
  cleanup.rememberCancellation(snapshot);
  const pending = phase === "force" ? cleanup.force(stop) : cleanup.finish();
  await vi.advanceTimersByTimeAsync(4999);
  expect(stop).not.toHaveBeenCalled(); expect(kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await pending;
  expect(stop).toHaveBeenCalledTimes(phase === "force" ? 1 : 0);
  expect(cleanup.diagnostics()).toEqual({ status: "unverified", observations: [
    { ok: true, phase: "before_cancel", source: "windows", elapsedMs: 1, skipped: 0 },
    { ok: false, phase: phase === "force" ? "before_force" : "after_exit", source: "windows", reason: "timeout", timeoutMs: 5000, elapsedMs: 5000 },
  ] });
  gate.resolve(snapshot); await vi.advanceTimersByTimeAsync(1);
  expect(kill).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledOnce();
});

test("an overdue query delivered before its timer is still discarded", async () => {
  const gate = Promise.withResolvers<tree.ProcessTableObservation>();
  vi.spyOn(reads, "observeProcessTableAsync").mockReturnValue(gate.promise);
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  const cleanup = processTreeCleanup(root.pid);
  const pending = cleanup.capture();
  clock.mockReturnValue(5001); gate.resolve(snapshot); await pending;
  expect(cleanup.diagnostics()).toEqual({ status: "unverified", observations: [
    { ok: false, phase: "before_eof", source: "windows", reason: "timeout", timeoutMs: 5000, elapsedMs: 5001 },
  ] });
});

test("the one-second cancellation budget also discards an overdue result delivered before its timer", async () => {
  const gate = Promise.withResolvers<tree.ProcessTableObservation>();
  vi.spyOn(reads, "observeProcessTableAsync").mockReturnValue(gate.promise);
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  const pending = observeBeforeCancellation();
  clock.mockReturnValue(1001); gate.resolve(snapshot);
  expect(await pending).toEqual({ ok: false, source: "windows", reason: "timeout", timeoutMs: 1000, elapsedMs: 1001 });
});
