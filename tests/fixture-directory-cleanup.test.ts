/* oxlint-disable eslint/max-statements -- Keep the deadline, late outcome and next-fixture sequence in one regression. */
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { removeFixtureDirectory } from "../sea-trial/harness/fixture-directory-cleanup.js";

const mocks = vi.hoisted(() => ({
  rm: vi.fn<() => Promise<void>>(),
  record: vi.fn<(entry: Record<string, unknown>) => void>(),
  write: vi.fn<(chunk: unknown) => boolean>(),
  snapshot: vi.fn<() => Promise<Record<string, unknown>>>(),
}));
vi.mock("node:fs/promises", () => ({ rm: mocks.rm }));
vi.mock("../sea-trial/harness/trace.js", () => ({ record: mocks.record }));
vi.mock("../sea-trial/harness/fixture-process-snapshot.js", () => ({ snapshotFixtureProcesses: mocks.snapshot }));
let now = 0;
beforeEach(() => {
  vi.useFakeTimers();
  now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  mocks.write.mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockImplementation(mocks.write);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllEnvs(); });

const purposes = ["codex-home", "opencode-vendor-cwd"];

test.each(purposes)("a slow removal releases fixture cleanup and retains its later completion (%s)", async (purpose) => {
  const deletion = Promise.withResolvers<void>();
  mocks.rm.mockReturnValue(deletion.promise);
  const returned = vi.fn();
  const stop = (async () => { await removeFixtureDirectory("home-A", purpose); returned(); })();
  await vi.advanceTimersByTimeAsync(4999);
  expect(returned).not.toHaveBeenCalled();
  now = 5000;
  await vi.advanceTimersByTimeAsync(1);
  await stop;
  expect(returned).toHaveBeenCalledOnce();
  expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ directory: "home-A", purpose, outcome: "pending", elapsedMs: 5000, residue: "unconfirmed" }));
  expect(mocks.write).toHaveBeenCalledWith(expect.stringContaining('"outcome":"pending"'));
  expect(vi.getTimerCount()).toBe(0);
  now = 91_472;
  deletion.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.record).toHaveBeenLastCalledWith(expect.objectContaining({ directory: "home-A", purpose, outcome: "removed", elapsedMs: 91_472, residue: "removed" }));
});

test.each(purposes)("a late refusal stays observed and cannot reject an already returned stop (%s)", async (purpose) => {
  const deletion = Promise.withResolvers<void>();
  mocks.rm.mockReturnValue(deletion.promise);
  const stop = removeFixtureDirectory("home-A", purpose);
  now = 5000;
  await vi.advanceTimersByTimeAsync(5000);
  await stop;
  deletion.reject(new Error("EPERM: cannot remove home-A"));
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.record).toHaveBeenLastCalledWith(expect.objectContaining({ directory: "home-A", purpose, outcome: "failed", error: "EPERM: cannot remove home-A" }));
  expect(mocks.write).toHaveBeenLastCalledWith(expect.stringContaining("EPERM"));
});

test.each(purposes)("fast deletion leaves no deadline or slow-cleanup warning (%s)", async (purpose) => {
  mocks.rm.mockResolvedValue(undefined);
  await removeFixtureDirectory("home-B", purpose);
  expect(mocks.rm).toHaveBeenCalledWith("home-B", { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  expect(mocks.record).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test.each(purposes)("a cleanup refusal preserves a preceding native failure even if diagnostics cannot write (%s)", async (purpose) => {
  mocks.rm.mockRejectedValue(new Error("EPERM"));
  mocks.record.mockImplementation(() => { throw new Error("trace closed"); });
  mocks.write.mockImplementation(() => { throw new Error("log closed"); });
  const nativeFailure = new Error("native assertion failed");
  async function run() {
    try { throw nativeFailure; }
    finally { await removeFixtureDirectory("home-A", purpose); }
  }
  await expect(run()).rejects.toBe(nativeFailure);
  expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed", error: "EPERM" }));
  expect(vi.getTimerCount()).toBe(0);
});

test.each(purposes)("late cleanup retains its own home while the next fixture finishes (%s)", async (purpose) => {
  const first = Promise.withResolvers<void>();
  mocks.rm.mockReturnValueOnce(first.promise).mockResolvedValueOnce(undefined);
  const stop = removeFixtureDirectory("home-A", purpose);
  now = 5000;
  await vi.advanceTimersByTimeAsync(5000);
  await stop;
  await removeFixtureDirectory("home-B", purpose);
  first.reject(new Error("first home still locked"));
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.record.mock.calls.map(call => call[0].directory)).toEqual(["home-A", "home-A"]);
  expect(mocks.rm).toHaveBeenCalledTimes(2);
});

test("a Windows Codex pending removal observes once without waiting for the process snapshot", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.stubEnv("OAR_TEST", "codex-aimock");
  const deletion = Promise.withResolvers<void>();
  const snapshot = Promise.withResolvers<Record<string, unknown>>();
  mocks.rm.mockReturnValueOnce(deletion.promise).mockResolvedValueOnce(undefined);
  mocks.snapshot.mockReturnValue(snapshot.promise);
  const stop = removeFixtureDirectory("old-cwd", "input-identity");
  now = 5000;
  await vi.advanceTimersByTimeAsync(5000);
  await stop;
  expect(mocks.snapshot).toHaveBeenCalledOnce();
  expect(mocks.record).toHaveBeenLastCalledWith(expect.objectContaining({ directory: "old-cwd", outcome: "pending" }));
  await removeFixtureDirectory("new-cwd", "input-identity");
  now = 6000;
  snapshot.resolve({ outcome: "captured", processes: [{ name: "codex.exe", pid: 17, parentPid: 3 }], truncated: false });
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.record).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "fixture_directory_processes", directory: "old-cwd", purpose: "input-identity", observerPid: process.pid, outcome: "captured", processes: [{ name: "codex.exe", pid: 17, parentPid: 3 }] }));
  deletion.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.snapshot).toHaveBeenCalledOnce();
  expect(mocks.record).toHaveBeenLastCalledWith(expect.objectContaining({ directory: "old-cwd", outcome: "removed" }));
});

test.each(["reject", "throw"])("a process observer %s cannot replace the original assertion failure", async (mode) => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.stubEnv("OAR_TEST", "codex-aimock");
  mocks.rm.mockReturnValue(Promise.withResolvers<void>().promise);
  if (mode === "throw") { mocks.snapshot.mockImplementation(() => { throw new Error("observer failed"); }); }
  else { mocks.snapshot.mockRejectedValue(new Error("observer failed")); }
  const original = new Error("native assertion failed");
  const check = expect((async () => {
    try { throw original; } finally { await removeFixtureDirectory("cwd", "vendor"); }
  })()).rejects.toBe(original);
  await vi.advanceTimersByTimeAsync(5000);
  await check;
  expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ kind: "fixture_directory_processes", outcome: "failed", reason: "observer" }));
});

test.each(["linux", "darwin", "win32"] as const)("process observation is absent for fast cleanup and other backends (%s)", async (platform) => {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  vi.stubEnv("OAR_TEST", "codex-aimock");
  mocks.rm.mockResolvedValueOnce(undefined);
  await removeFixtureDirectory("fast", "vendor");
  vi.stubEnv("OAR_TEST", platform === "win32" ? "opencode-aimock" : "codex-aimock");
  mocks.rm.mockReturnValueOnce(Promise.withResolvers<void>().promise);
  const stop = removeFixtureDirectory("slow", "vendor");
  await vi.advanceTimersByTimeAsync(5000);
  await stop;
  expect(mocks.snapshot).not.toHaveBeenCalled();
});
