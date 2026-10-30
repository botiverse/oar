import { afterEach, expect, test, vi } from "vitest";
import { checkedProcessTable } from "../experiments/sharing/process-table.js";
import { readProcessTable } from "../packages/oar/src/shared/executable/process-tree.js";
import { asRecord } from "../packages/oar/src/shared/json.js";

vi.mock("../packages/oar/src/shared/executable/process-tree.js", () => ({ readProcessTable: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: vi.fn(() => ({ status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" }, stdout: "", stderr: "" })) }));
afterEach(() => { vi.restoreAllMocks(); });

test("an unreadable table remains failed evidence with a duration and no invented entries", () => {
  vi.mocked(readProcessTable).mockReturnValue(new Map());
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  expect(checkedProcessTable).toThrow("process table unavailable:");
  expect(stderr).toHaveBeenCalledOnce();
  const diagnostic: unknown = JSON.parse(String(stderr.mock.calls[0]?.[0]));
  expect(diagnostic).toMatchObject({ kind: "process_table_unavailable", entries: 0, selfPresent: false });
  expect(asRecord(diagnostic)?.elapsedMs).toEqual(expect.any(Number));
  if (process.platform === "win32") {
    expect(diagnostic).toMatchObject({ followup: { exitCode: null, errorCode: "ETIMEDOUT", parseFailed: true } });
  }
});

test("a table with the host is retained unchanged", () => {
  const table = new Map([[process.pid, { pid: process.pid, ppid: process.ppid, pgid: 0, start: "test" }]]);
  vi.mocked(readProcessTable).mockReturnValue(table);
  expect(checkedProcessTable()).toBe(table);
});
