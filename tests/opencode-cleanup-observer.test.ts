import { afterEach, expect, test, vi } from "vitest";
import { cleanupObserver } from "../sea-trial/vendor/support/opencode-cleanup.js";
import { checkedProcessTable } from "../experiments/sharing/process-table.js";

vi.mock("../experiments/sharing/process-table.js", () => ({ checkedProcessTable: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

// oxlint-disable-next-line eslint/max-statements -- Compare the identity before liveness with the fresh identity immediately before signals.
test.each([false, true])("fixture reclamation rechecks creation identity after PID liveness (reused: %s)", reused => {
  const host = { pid: process.pid, ppid: process.ppid, pgid: 0, start: "host" };
  const tool = { pid: 6400, ppid: process.pid, pgid: 0, start: "tool" };
  vi.mocked(checkedProcessTable)
    .mockReturnValueOnce(new Map([host, tool].map(entry => [entry.pid, entry])))
    .mockReturnValueOnce(new Map([host, { ...tool, start: reused ? "replacement" : "tool" }].map(entry => [entry.pid, entry])));
  const signal = vi.spyOn(process, "kill").mockReturnValue(true);
  const observer = cleanupObserver("unused");
  if (reused) { expect(() => { observer.reclaim(); }).not.toThrow(); }
  else { expect(() => { observer.reclaim(); }).toThrow("Native cleanup evidence or final tree assertion failed"); }
  expect(signal.mock.calls).toEqual(reused ? [[tool.pid, 0]] : [[tool.pid, 0], [tool.pid, "SIGKILL"]]);
  expect(checkedProcessTable).toHaveBeenCalledTimes(2);
  expect(checkedProcessTable).toHaveBeenNthCalledWith(1, "opencode-fixture-reclaim", process.platform, true);
  expect(checkedProcessTable).toHaveBeenNthCalledWith(2, "opencode-fixture-revalidate", process.platform, true);
});
