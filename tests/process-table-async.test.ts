import { afterEach, expect, test, vi } from "vitest";
import { observeProcessTableOnce } from "../packages/oar/src/shared/executable/process-table-async.js";
import { processTableCommand } from "../packages/oar/src/shared/executable/process-table-command.js";

vi.mock("../packages/oar/src/shared/executable/process-table-command.js", () => ({ processTableCommand: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); });

test("async CIM keeps readable identities and counts inaccessible rows", async () => {
  vi.mocked(processTableCommand).mockResolvedValue(JSON.stringify([
    { ProcessId: process.pid, ParentProcessId: process.ppid, Started: "host" },
    { ProcessId: 101, ParentProcessId: process.pid, Started: "tool" },
    { ProcessId: 102, ParentProcessId: process.pid, Started: null },
  ]));
  const result = await observeProcessTableOnce("windows");
  expect(result.ok).toBe(true);
  if (!result.ok) { throw new Error(JSON.stringify(result)); }
  expect([...result.table.values()]).toEqual([
    { pid: process.pid, ppid: process.ppid, pgid: 0, start: "host" },
    { pid: 101, ppid: process.pid, pgid: 0, start: "tool" },
  ]);
  expect(result.skipped).toBe(1);
});

test.each([
  ["[]", "missing_host"],
  ["private invalid JSON", "invalid_output"],
  [JSON.stringify([{ ProcessId: process.pid, ParentProcessId: process.ppid, Started: null }]), "missing_host"],
  [JSON.stringify([{ ProcessId: 1.5, ParentProcessId: process.ppid, Started: "bad" }]), "invalid_output"],
])("async CIM rejects unusable output without retaining its contents: %s", async (output, reason) => {
  vi.mocked(processTableCommand).mockResolvedValue(output);
  const result = await observeProcessTableOnce("windows");
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- Vitest asymmetric duration matcher.
  expect(result).toEqual({ ok: false, source: "windows", reason, elapsedMs: expect.any(Number) });
});

test("async ps parses the same identities under the C locale", async () => {
  vi.mocked(processTableCommand).mockResolvedValue(`${process.pid} ${process.ppid} 77 Fri Oct 30 20:00:00 2026\n`);
  const result = await observeProcessTableOnce("ps");
  expect(result.ok).toBe(true);
  if (!result.ok) { throw new Error(JSON.stringify(result)); }
  expect(result.table.get(process.pid)).toEqual({ pid: process.pid, ppid: process.ppid, pgid: 77, start: "Fri Oct 30 20:00:00 2026" });
  expect(vi.mocked(processTableCommand).mock.calls[0]?.[2]?.LC_ALL).toBe("C");
});
