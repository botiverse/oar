/* oxlint-disable typescript/no-unsafe-assignment -- Vitest structural matchers describe timing values. */
import { execFileSync } from "node:child_process";
import { afterEach, expect, test, vi } from "vitest";
import { checkedProcessTable } from "../experiments/sharing/process-table.js";
import { observeProcessTable } from "../packages/oar/src/shared/executable/process-tree.js";

vi.mock("../packages/oar/src/shared/executable/process-tree.js", async (original) => ({ ...await original<object>(), observeProcessTable: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
const self = { ProcessId: process.pid, ParentProcessId: process.ppid, Started: "2026-10-30T00:00:00Z" };

test("loaded Windows reads retain duration and accept a query longer than the product limit", () => {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ queryMs: 7300, rows: [self, { ProcessId: 9, ParentProcessId: 0, Started: null }] }));
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const table = checkedProcessTable("loaded-cleanup", "win32");
  expect(table.get(process.pid)?.start).toBe(self.Started);
  expect(execFileSync).toHaveBeenCalledWith("powershell.exe", expect.any(Array), expect.objectContaining({ timeout: 60_000 }));
  expect(observeProcessTable).not.toHaveBeenCalled();
  expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({ label: "loaded-cleanup", outcome: "completed", queryMs: 7300, skipped: 1, elapsedMs: expect.any(Number) });
});

test.each(["timeout", "malformed", "missing-host"])("%s stays failed evidence without a fallback or native output disclosure", mode => {
  vi.mocked(execFileSync).mockImplementation(() => {
    if (mode === "timeout") { throw Object.assign(new Error("private command and output"), { code: "ETIMEDOUT", signal: "SIGTERM" }); }
    return mode === "malformed" ? "private non-json output" : JSON.stringify({ queryMs: 1, rows: [] });
  });
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  expect(() => checkedProcessTable("test", "win32")).toThrow("Probe process table unavailable:");
  expect(execFileSync).toHaveBeenCalledOnce();
  const output = String(stdout.mock.calls[0]?.[0]);
  expect(output).not.toContain("private");
  expect(JSON.parse(output)).toMatchObject({ outcome: "failed", elapsedMs: expect.any(Number), timeoutMs: 60_000 });
});

test("procfs retains structural validation without a subprocess deadline", () => {
  const table = new Map([[process.pid, { pid: process.pid, ppid: process.ppid, pgid: 1, start: "test" }]]);
  vi.mocked(observeProcessTable).mockReturnValue({ ok: true, table, skipped: 0, source: "procfs", elapsedMs: 1 });
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  expect(checkedProcessTable("test", "linux")).toBe(table);
});

test("a failed procfs read stays failed", () => {
  vi.mocked(observeProcessTable).mockReturnValue({ ok: false, source: "procfs", elapsedMs: 1, reason: "read_failed" });
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  expect(() => checkedProcessTable("test", "linux")).toThrow("Probe process table unavailable:");
});


test("Windows probe can exclude its own sampler and conhost without excluding another child", () => {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ queryMs: 1, readerPid: 900,
    rows: [self, { ProcessId: 900, ParentProcessId: process.pid, Started: self.Started },
      { ProcessId: 901, ParentProcessId: 900, Started: self.Started }, { ProcessId: 902, ParentProcessId: process.pid, Started: self.Started }],
  }));
  const table = checkedProcessTable("observer-exclusion", "win32", true);
  expect([...table.keys()]).toEqual([process.pid, 902]);
});

test("POSIX probe excludes the exact ps identity reported by its exec shell", () => {
  vi.mocked(execFileSync).mockReturnValue(`900\n${process.pid} ${process.ppid} 100 Sat Oct 31 00:00:00 2026\n900 ${process.pid} 100 Sat Oct 31 00:01:00 2026\n902 ${process.pid} 100 Sat Oct 31 00:01:00 2026\n`);
  expect([...checkedProcessTable("observer-exclusion", "darwin", true).keys()]).toEqual([process.pid, 902]);
});
