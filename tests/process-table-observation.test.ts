import { execFileSync } from "node:child_process";
import { afterEach, expect, test, vi } from "vitest";
import { descendantsOf, killEntries, observeProcessTable, readProcessTable } from "../packages/oar/src/shared/executable/process-tree.js";

const procfs = vi.hoisted(() => ({ read: vi.fn<(path: string) => string>(), list: vi.fn<() => string[]>() }));
vi.mock("node:child_process", async (original) => ({ ...await original<object>(), execFileSync: vi.fn() }));
vi.mock("node:fs", async (original) => ({ ...await original<object>(), readFileSync: procfs.read, readdirSync: procfs.list }));
afterEach(() => { vi.restoreAllMocks(); vi.mocked(execFileSync).mockReset(); procfs.read.mockReset(); procfs.list.mockReset(); });

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
  expect(result).toMatchObject({ skipped: 0 });
  expect([...result.table.values()]).toEqual([{ pid: process.pid, ppid: process.ppid, pgid: 0, start: "identity" }]);
});

test.each([
  { ProcessId: 1.5, ParentProcessId: 1, Started: null },
  { ProcessId: "private-pid", ParentProcessId: 1, Started: null },
  { ProcessId: 10, ParentProcessId: 0.5, Started: null },
  { ProcessId: 10, ParentProcessId: 1, Started: 17 },
])("malformed Windows identities fail even when other rows are valid: %j", (invalid) => {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify([
    { ProcessId: process.pid, ParentProcessId: process.ppid, Started: "identity" },
    invalid,
  ]));
  expect(observeProcessTable("windows")).toMatchObject({ ok: false, reason: "invalid_output" });
});

// oxlint-disable-next-line eslint/max-statements -- One partial table must preserve both descendant discovery and safe signalling.
test("Windows protected entries without creation times are counted without hiding owned descendants", () => {
  const root = process.pid + 100;
  const tool = root + 1;
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify([
    { ProcessId: process.pid, ParentProcessId: process.ppid, Started: "host" },
    { ProcessId: root, ParentProcessId: process.pid, Started: "root" },
    { ProcessId: tool, ParentProcessId: root, Started: "tool" },
    { ProcessId: root + 2, ParentProcessId: 1, Started: null },
    { ProcessId: root + 3, ParentProcessId: 1 },
    { ProcessId: root + 4, ParentProcessId: 1, Started: "" },
  ]));
  const result = observeProcessTable("windows");
  expect(result).toMatchObject({ ok: true, skipped: 3 });
  if (!result.ok) { throw new Error("expected table"); }
  const descendants = descendantsOf(result.table, root);
  expect(descendants).toEqual([{ pid: tool, ppid: root, pgid: 0, start: "tool" }]);
  expect(result.table.size).toBe(3);
  const signal = vi.spyOn(process, "kill").mockReturnValue(true);
  killEntries(descendants, result.table);
  expect(signal.mock.calls).toEqual([[tool, "SIGKILL"]]);
});

test("Windows skipping the host's missing identity still fails the observation", () => {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ ProcessId: process.pid, ParentProcessId: process.ppid, Started: null }));
  expect(observeProcessTable("windows")).toMatchObject({ ok: false, reason: "missing_host" });
});

function stat(pid: number, ppid: number): string {
  return `${String(pid)} (private-process) ${["S", ppid, 1, ...Array.from({ length: 16 }, () => 0), 123].join(" ")}`;
}

// oxlint-disable-next-line eslint/max-statements -- One permission failure must preserve both descendant discovery and safe signalling.
test.each(["EACCES", "EPERM"])("procfs permission-denied entries are counted without hiding owned descendants: %s", (code) => {
  const root = process.pid + 100;
  const tool = root + 1;
  procfs.list.mockReturnValue([process.pid, root, tool, root + 2].map(String));
  const stats = new Map([
    [`/proc/${String(process.pid)}/stat`, stat(process.pid, process.ppid)],
    [`/proc/${String(root)}/stat`, stat(root, process.pid)],
    [`/proc/${String(tool)}/stat`, stat(tool, root)],
  ]);
  procfs.read.mockImplementation((path) => {
    const value = stats.get(path);
    if (value === undefined) { throw Object.assign(new Error("private denied path"), { code }); }
    return value;
  });
  const result = observeProcessTable("procfs");
  expect(result).toMatchObject({ ok: true, skipped: 1 });
  if (!result.ok) { throw new Error("expected table"); }
  const descendants = descendantsOf(result.table, root);
  expect(descendants).toEqual([{ pid: tool, ppid: root, pgid: 1, start: "123" }]);
  expect(result.table.size).toBe(3);
  const signal = vi.spyOn(process, "kill").mockReturnValue(true);
  killEntries(descendants, result.table);
  expect(signal.mock.calls).toEqual([[tool, "SIGKILL"]]);
});

test("procfs permission-denied host and structural read errors remain failures", () => {
  procfs.list.mockReturnValue([String(process.pid)]);
  procfs.read.mockImplementation(() => { throw Object.assign(new Error("private denied path"), { code: "EACCES" }); });
  expect(observeProcessTable("procfs")).toMatchObject({ ok: false, reason: "missing_host" });
  procfs.read.mockImplementation(() => { throw Object.assign(new Error("private read error"), { code: "EIO" }); });
  expect(observeProcessTable("procfs")).toMatchObject({ ok: false, reason: "read_failed", code: "EIO" });
  procfs.list.mockImplementation(() => { throw Object.assign(new Error("private directory error"), { code: "EACCES" }); });
  expect(observeProcessTable("procfs")).toMatchObject({ ok: false, reason: "read_failed", code: "EACCES" });
});

test("malformed ps rows fail even when the host row was readable", () => {
  vi.mocked(execFileSync).mockReturnValue(`${String(process.pid)} ${String(process.ppid)} 1 Fri Oct 30 00:00:00 2026\nmalformed private-row\n`);
  expect(observeProcessTable("ps")).toMatchObject({ ok: false, reason: "invalid_output" });
});
