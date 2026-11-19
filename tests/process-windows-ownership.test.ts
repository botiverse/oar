import { afterEach, expect, test, vi } from "vitest";
import { processTreeCleanup } from "../packages/oar/src/shared/executable/process-cleanup.js";
import { descendantsOf, type ProcessEntry, type ProcessTableObservation } from "../packages/oar/src/shared/executable/process-tree.js";
// oxlint-disable-next-line import/no-namespace -- Inject native-shaped tables while exercising real ownership and signal decisions.
import * as tables from "../packages/oar/src/shared/executable/process-table-async.js";

afterEach(() => { vi.restoreAllMocks(); });
const entry = (pid: number, ppid: number, hour: number): ProcessEntry => ({ pid, ppid, pgid: 0, start: `2026-10-31T${String(hour).padStart(2, "0")}:00:00.0000000Z` });
const host = entry(process.pid, process.ppid, 0), root = entry(8048, process.pid, 4), tool = entry(6400, root.pid, 5);
const observation = (...entries: ProcessEntry[]): Extract<ProcessTableObservation, { ok: true }> => ({ ok: true, source: "windows", elapsedMs: 1, skipped: 0, table: new Map([host, ...entries].map(row => [row.pid, row])) });

// oxlint-disable-next-line eslint/max-statements -- Exercise both traversal and actual signal selection on stale Windows ancestry.
test("Windows parent edges exclude a previous PID owner's older child and its whole subtree", async () => {
  const stale = entry(5120, root.pid, 2), unrelated = entry(5121, stale.pid, 6);
  const snapshot = observation(root, stale, unrelated, tool, entry(6401, tool.pid, 5));
  expect(descendantsOf(snapshot.table, root.pid, "windows").map(row => row.pid)).toEqual([tool.pid, 6401]);
  vi.spyOn(tables, "observeProcessTableAsync").mockResolvedValueOnce(snapshot).mockResolvedValueOnce(snapshot).mockResolvedValue(observation());
  const signal = vi.spyOn(process, "kill").mockReturnValue(true);
  const cleanup = processTreeCleanup(root.pid);
  await cleanup.capture(); await cleanup.finish();
  expect(signal.mock.calls).toEqual([[tool.pid, "SIGKILL"], [6401, "SIGKILL"]]);
});

// oxlint-disable-next-line eslint/max-statements -- Revalidation must both discover new descendants and reject reused or stale ancestry.
test.each((["force", "finish", "host-exit"] as const).flatMap(phase => [false, true].map(reused => [phase, reused] as const)))("%s follows new children of captured tools only while their identity matches (reused: %s)", async (phase, reused) => {
  const newcomer = entry(6896, tool.pid, 7), stale = entry(5120, tool.pid, 3);
  const read = vi.spyOn(tables, "observeProcessTableAsync").mockResolvedValueOnce(observation(root, tool));
  const signal = vi.spyOn(process, "kill").mockReturnValue(true);
  const cleanup = processTreeCleanup(root.pid);
  await cleanup.capture();
  // The root is gone; Windows keeps the tool's original ParentProcessId.
  const after = observation(reused ? { ...tool, start: entry(tool.pid, root.pid, 6).start } : tool, newcomer, stale);
  read.mockResolvedValueOnce(after).mockResolvedValue(observation());
  if (phase === "force") { await cleanup.force(() => {}); }
  else if (phase === "finish") { await cleanup.finish(); }
  else { cleanup.finishSync(() => after); }
  expect(signal.mock.calls).toEqual(reused ? [] : [[tool.pid, "SIGKILL"], [newcomer.pid, "SIGKILL"]]);
});

test("permission refusal and an unverifiable owned descendant have independent outcomes", async () => {
  const foreign = entry(6410, root.pid, 6);
  const initial = observation(root, tool, foreign);
  const remaining = observation();
  vi.spyOn(tables, "observeProcessTableAsync").mockResolvedValueOnce(initial)
    .mockResolvedValue({ ...remaining, unreadable: new Set([tool.pid]), skipped: 1 });
  vi.spyOn(process, "kill").mockImplementation(pid => {
    if (pid === foreign.pid) { throw Object.assign(new Error("permission denied"), { code: "EPERM" }); }
    return true;
  });
  const cleanup = processTreeCleanup(root.pid);
  cleanup.rememberCancellation(initial);
  await cleanup.finish();
  expect(cleanup.diagnostics()).toMatchObject({ status: "unverified", foreign: 1 });
  expect(cleanup.diagnostics().observations.at(-1)).toMatchObject({ ok: false, reason: "descendant_unreadable" });
});
