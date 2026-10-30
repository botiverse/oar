import { execFileSync } from "node:child_process";
import { afterEach, expect, test, vi } from "vitest";
import { observeProcessTable, readProcessTable } from "../packages/oar/src/shared/executable/process-tree.js";

vi.mock("node:child_process", async (original) => ({ ...await original<object>(), execFileSync: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.mocked(execFileSync).mockReset(); });

test.each([
  { native: { code: "ETIMEDOUT", status: null, signal: "SIGTERM" }, expected: { reason: "timeout", code: "ETIMEDOUT", signal: "SIGTERM", timeoutMs: 5000 } },
  { native: { code: "ENOENT" }, expected: { reason: "spawn_failed", code: "ENOENT" } },
  { native: { code: "EACCES" }, expected: { reason: "spawn_failed", code: "EACCES" } },
  { native: { status: 3 }, expected: { reason: "command_failed", exitCode: 3 } },
  { native: { code: "ENOBUFS", signal: "SIGTERM" }, expected: { reason: "read_failed", code: "ENOBUFS", signal: "SIGTERM" } },
])("process table failures preserve native fields: $expected.reason $native.code", ({ native, expected }) => {
  vi.mocked(execFileSync).mockImplementation(() => { throw Object.assign(new Error("secret command and output"), native, { stdout: "private-process-list", stderr: "private-environment" }); });
  vi.spyOn(performance, "now").mockReturnValueOnce(10).mockReturnValueOnce(5011);
  const result = observeProcessTable("windows");
  expect(result).toEqual({ ok: false, source: "windows", elapsedMs: 5001, ...expected });
  expect(JSON.stringify(result)).not.toMatch(/secret|private/u);
  expect(() => readProcessTable("windows")).toThrow(/Process table windows/u);
  expect(vi.mocked(execFileSync).mock.calls[0]?.[2]).toMatchObject({ timeout: 5000 });
});

test.each(["{bad secret-json", "null", "[]", '{"ProcessId":999,"ParentProcessId":1,"Started":"now"}'])("invalid or incomplete Windows output never becomes an empty table: %s", (output) => {
  vi.mocked(execFileSync).mockReturnValue(output);
  expect(observeProcessTable("windows")).toMatchObject({ ok: false, reason: output.startsWith("{bad") || output === "null" ? "invalid_output" : "missing_host" });
});

test("a valid table can have no descendants, and is not a read failure", () => {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ ProcessId: process.pid, ParentProcessId: process.ppid, Started: "identity" }));
  const result = observeProcessTable("windows");
  expect(result.ok).toBe(true);
  if (!result.ok) { throw new Error("expected table"); }
  expect([...result.table.values()]).toEqual([{ pid: process.pid, ppid: process.ppid, pgid: 0, start: "identity" }]);
});

test("one malformed Windows process does not disappear from an otherwise valid table", () => {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify([
    { ProcessId: process.pid, ParentProcessId: process.ppid, Started: "identity" },
    { ProcessId: process.pid + 1, ParentProcessId: process.pid, Started: null },
  ]));
  expect(observeProcessTable("windows")).toMatchObject({ ok: false, reason: "invalid_output" });
});

test("malformed ps rows fail even when the host row was readable", () => {
  vi.mocked(execFileSync).mockReturnValue(`${String(process.pid)} ${String(process.ppid)} 1 Fri Oct 30 00:00:00 2026\nmalformed private-row\n`);
  expect(observeProcessTable("ps")).toMatchObject({ ok: false, reason: "invalid_output" });
});
