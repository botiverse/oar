/* oxlint-disable eslint/max-statements -- Keep capture, root exit and force assertions together in each lifecycle regression. */
import { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { stopProbe } from "../packages/oar/src/shared/executable/probe-cleanup.js";
import { observeProcessTableWithin } from "../packages/oar/src/shared/executable/process-table-budget.js";
import { trackPendingCleanup } from "../packages/oar/src/shared/executable/ownership.js";
import type { ProcessEntry, ProcessTableObservation } from "../packages/oar/src/shared/executable/process-tree.js";

vi.mock("../packages/oar/src/shared/executable/process-table-budget.js", () => ({ observeProcessTableWithin: vi.fn() }));
vi.mock("../packages/oar/src/shared/executable/ownership.js", () => ({ trackPendingCleanup: vi.fn() }));
const host = { pid: process.pid, ppid: 1, pgid: process.pid, start: "host" };
const root = { pid: 900_001, ppid: process.pid, pgid: 900_001, start: "root" };
const tool = { pid: 900_002, ppid: root.pid, pgid: root.pid, start: "tool" };
const snapshot = (...entries: ProcessEntry[]): ProcessTableObservation => ({
  ok: true, source: "ps", elapsedMs: 1, skipped: 0, table: new Map([host, ...entries].map(entry => [entry.pid, entry])),
});
const failure: ProcessTableObservation = { ok: false, source: "ps", elapsedMs: 5000, reason: "timeout", timeoutMs: 5000 };
const forget = vi.fn<() => void>();
const signals = vi.fn<typeof process.kill>();
function child(): ChildProcess {
  const value = new ChildProcess();
  Object.defineProperty(value, "pid", { value: root.pid });
  vi.spyOn(value, "kill").mockReturnValue(true);
  return value;
}
function close(value: ChildProcess): void { Object.defineProperty(value, "exitCode", { value: 0, configurable: true }); value.emit("close", 0, null); }
beforeEach(() => {
  vi.useFakeTimers();
  signals.mockReturnValue(true);
  vi.spyOn(process, "kill").mockImplementation(signals);
  vi.mocked(trackPendingCleanup).mockReturnValue(forget);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); });

test("close retains captured identities, including detached tools and their new children", async () => {
  const detached = { ...tool, pgid: tool.pid };
  const late = { pid: 900_003, ppid: tool.pid, pgid: 900_003, start: "late" };
  vi.mocked(observeProcessTableWithin).mockResolvedValueOnce(snapshot(root, detached)).mockResolvedValueOnce(snapshot({ ...detached, ppid: 1 }, late));
  const value = child();
  stopProbe(value, 100);
  await vi.advanceTimersByTimeAsync(0);
  close(value);
  expect(forget).not.toHaveBeenCalled();
  signals.mockClear();
  await vi.advanceTimersByTimeAsync(100);
  expect(signals).toHaveBeenCalledWith(tool.pid, "SIGKILL");
  expect(signals).toHaveBeenCalledWith(late.pid, "SIGKILL");
  expect(signals).not.toHaveBeenCalledWith(-root.pid, "SIGKILL");
  expect(forget).toHaveBeenCalledOnce();
});

test.each(["pid", "group"])("does not signal a reused %s after close", async mode => {
  const replacement = mode === "pid" ? { ...tool, start: "replacement" } : { ...tool, pid: 900_004, start: "replacement" };
  vi.mocked(observeProcessTableWithin).mockResolvedValueOnce(snapshot(root, tool)).mockResolvedValueOnce(snapshot({ ...root, start: "replacement" }, replacement));
  const value = child();
  stopProbe(value, 100);
  await vi.advanceTimersByTimeAsync(0);
  close(value);
  signals.mockClear();
  await vi.advanceTimersByTimeAsync(100);
  expect(signals).not.toHaveBeenCalled();
  expect(vi.spyOn(value, "kill")).not.toHaveBeenCalled();
});

test("a failed force observation never signals remembered descendants", async () => {
  vi.mocked(observeProcessTableWithin).mockResolvedValueOnce(snapshot(root, tool)).mockResolvedValueOnce(failure);
  const value = child();
  stopProbe(value, 100);
  await vi.advanceTimersByTimeAsync(0);
  close(value);
  signals.mockClear();
  await vi.advanceTimersByTimeAsync(100);
  expect(signals).not.toHaveBeenCalled();
  expect(forget).toHaveBeenCalledOnce();
});

test("host exit after close revalidates retained identities synchronously", async () => {
  vi.mocked(observeProcessTableWithin).mockResolvedValue(snapshot(root, tool));
  const value = child();
  stopProbe(value, 100);
  await vi.advanceTimersByTimeAsync(0);
  close(value);
  signals.mockClear();
  const finish = vi.mocked(trackPendingCleanup).mock.calls[0]?.[0];
  expect(finish?.(() => snapshot({ ...tool, ppid: 1 }))).toMatchObject({ status: "observed" });
  expect(signals).toHaveBeenCalledWith(tool.pid, "SIGKILL");
});

test("close during the initial observation cannot authorize a new group owner", async () => {
  const gate = Promise.withResolvers<ProcessTableObservation>();
  vi.mocked(observeProcessTableWithin).mockReturnValueOnce(gate.promise).mockResolvedValue(snapshot(tool));
  const value = child();
  stopProbe(value, 100);
  close(value);
  gate.resolve(snapshot(tool));
  await vi.advanceTimersByTimeAsync(100);
  expect(signals).not.toHaveBeenCalled();
});

test("the exited launcher's still-open pipes allow capturing its existing group", async () => {
  vi.mocked(observeProcessTableWithin).mockResolvedValue(snapshot({ ...tool, ppid: 1 }));
  const value = child();
  Object.defineProperty(value, "exitCode", { value: 0, configurable: true });
  stopProbe(value, 100);
  await vi.advanceTimersByTimeAsync(0);
  expect(signals).toHaveBeenCalledWith(tool.pid, "SIGTERM");
  close(value);
  await vi.advanceTimersByTimeAsync(100);
  expect(signals).toHaveBeenCalledWith(tool.pid, "SIGKILL");
});
