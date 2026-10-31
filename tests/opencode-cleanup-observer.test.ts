import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanupObserver } from "../sea-trial/vendor/support/opencode-cleanup.js";
import { linuxProcessState } from "../sea-trial/vendor/support/process-reclamation.js";
import { checkedProcessTable } from "../experiments/sharing/process-table.js";

vi.mock("../experiments/sharing/process-table.js", () => ({ checkedProcessTable: vi.fn() }));
vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<Record<string, unknown>>(), readFileSync: vi.fn() }));
vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async (ms: number) => { vi.advanceTimersByTime(ms); }) }));

const host = { pid: process.pid, ppid: process.ppid, pgid: 0, start: "1" };
const tool = { pid: 6400, ppid: process.pid, pgid: 0, start: "100" };
const table = new Map([host, tool].map(entry => [entry.pid, entry]));
function stat(state = "S", start = "100"): string {
  const fields = Array.from({ length: 20 }, () => "0"); fields[0] = state; fields[1] = String(process.pid); fields[19] = start;
  return `6400 (fixture (child)) ${fields.join(" ")}`;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  vi.mocked(readFileSync).mockReturnValue(stat());
  vi.mocked(checkedProcessTable).mockReturnValue(table);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); });

test.each([false, true])("fixture reclamation rechecks creation identity after the bounded wait (reused: %s)", async reused => {
  vi.mocked(checkedProcessTable).mockImplementation(label => label === "opencode-fixture-revalidate" && reused
    ? new Map([host, { ...tool, start: "200" }].map(entry => [entry.pid, entry])) : table);
  const signals: { signal: string | number | undefined; at: number }[] = [];
  vi.spyOn(process, "kill").mockImplementation((_pid, signal) => { signals.push({ signal, at: performance.now() }); return true; });
  const observer = cleanupObserver("unused");
  await (reused ? expect(observer.reclaim()).resolves.toBeUndefined()
    : expect(observer.reclaim()).rejects.toThrow("Native cleanup evidence or final tree assertion failed"));
  expect(signals.filter(call => call.signal !== 0)).toEqual(reused ? [] : [{ signal: "SIGKILL", at: 2000 }]);
  expect(checkedProcessTable).toHaveBeenLastCalledWith("opencode-fixture-revalidate", process.platform, true);
  expect(observer.observations).toContainEqual(expect.objectContaining({ stage: "fixture-reclaim", elapsedMs: 2000, waitMs: 2000 }));
});

test("a descendant finishing exit within the observation window is not reclaimed", async () => {
  vi.mocked(checkedProcessTable).mockImplementation(() => performance.now() < 25 ? table : new Map([[host.pid, host]]));
  const signal = vi.spyOn(process, "kill").mockReturnValue(true);
  const observer = cleanupObserver("unused"); await observer.reclaim();
  expect(signal.mock.calls.every(call => call[1] === 0)).toBe(true);
  expect(observer.observations).toContainEqual(expect.objectContaining({ elapsedMs: 25, processes: [], zombies: [] }));
});

test.skipIf(process.platform !== "linux")("a live descendant becoming a zombie is recorded separately and never signalled", async () => {
  vi.mocked(readFileSync).mockImplementation(() => stat(performance.now() < 25 ? "S" : "Z"));
  const signal = vi.spyOn(process, "kill").mockReturnValue(true);
  const observer = cleanupObserver("unused"); await observer.reclaim();
  expect(signal.mock.calls.every(call => call[1] === 0)).toBe(true);
  expect(observer.observations).toContainEqual(expect.objectContaining({ elapsedMs: 25, processes: [],
    zombies: [{ ...tool, state: "Z" }], snapshots: [expect.objectContaining({ processes: [{ ...tool, state: "S" }] }),
      expect.objectContaining({ processes: [{ ...tool, state: "Z" }] })] }));
});

test.skipIf(process.platform !== "linux")("unreadable state fails instead of treating a live process as a zombie", async () => {
  vi.mocked(readFileSync).mockImplementation(() => { throw Object.assign(new Error("stat denied"), { code: "EACCES" }); });
  const signal = vi.spyOn(process, "kill").mockReturnValue(true);
  await expect(cleanupObserver("unused").reclaim()).rejects.toThrow("stat denied");
  expect(signal.mock.calls.every(call => call[1] === 0)).toBe(true);
});

test.skipIf(process.platform !== "linux")("the final revalidation retains a newly observed zombie without signalling it", async () => {
  let revalidating = false;
  vi.mocked(checkedProcessTable).mockImplementation(label => { revalidating = label === "opencode-fixture-revalidate"; return table; });
  vi.mocked(readFileSync).mockImplementation(() => stat(revalidating ? "Z" : "S"));
  const signal = vi.spyOn(process, "kill").mockReturnValue(true);
  const observer = cleanupObserver("unused"); await observer.reclaim();
  expect(signal.mock.calls.every(call => call[1] === 0)).toBe(true);
  expect(observer.observations).toContainEqual(expect.objectContaining({ elapsedMs: 2000, processes: [], zombies: [{ ...tool, state: "Z" }] }));
});

test("Linux state is accepted only for the observed creation identity", () => {
  vi.mocked(readFileSync).mockReturnValue(stat("Z", "200")); expect(linuxProcessState(tool)).toBeNull();
  vi.mocked(readFileSync).mockReturnValue(stat("Z")); expect(linuxProcessState(tool)).toBe("Z");
  vi.mocked(readFileSync).mockReturnValue(stat("??")); expect(() => linuxProcessState(tool)).toThrow("Invalid Linux process state");
  vi.mocked(readFileSync).mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); });
  expect(linuxProcessState(tool)).toBeNull();
});
