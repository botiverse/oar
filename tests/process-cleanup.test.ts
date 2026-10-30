import { afterEach, expect, test, vi } from "vitest";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { killProcessTree, spawnLineProcess } from "../packages/oar/src/shared/executable/process.js";
import { cleanupFailureReason, processTreeCleanup } from "../packages/oar/src/shared/executable/process-cleanup.js";
// oxlint-disable-next-line import/no-namespace -- Spy on the reader while retaining real process enumeration for recovery.
import * as tree from "../packages/oar/src/shared/executable/process-tree.js";
import { gone } from "./fixtures/process-tree.js";

vi.mock("node:child_process", async (original) => ({ ...await original<object>(), execFile: vi.fn() }));

const failure: tree.ProcessTableFailure = { ok: false, source: "windows", reason: "timeout", code: "ETIMEDOUT", timeoutMs: 5000, elapsedMs: 5004 };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

test("two failed reads before EOF are both retained, and never represented as no descendants", () => {
  const retry: tree.ProcessTableFailure = { ok: false, source: "windows", reason: "command_failed", exitCode: 3, elapsedMs: 17 };
  const read = vi.spyOn(tree, "observeProcessTable").mockReturnValueOnce(failure).mockReturnValueOnce(retry);
  const cleanup = processTreeCleanup(123);
  cleanup.capture(); cleanup.finish();
  expect(read).toHaveBeenCalledTimes(2);
  expect(cleanup.diagnostics()).toEqual({ status: "unverified", observations: [{ ...failure, phase: "before_eof" }, { ...retry, phase: "before_eof" }] });
  expect(cleanupFailureReason(cleanup.diagnostics())).toMatch(/timeout.*command_failed/u);
});

// oxlint-disable-next-line eslint/max-statements -- One failed force observation must still stop its root.
test("force escalation still stops the owned root when the revalidation read fails", () => {
  const read = vi.spyOn(tree, "observeProcessTable").mockReturnValue(failure);
  const kill = vi.spyOn(tree, "killEntries");
  const cleanup = processTreeCleanup(123);
  cleanup.capture();
  const stopRoot = vi.fn<() => void>();
  cleanup.force(stopRoot); cleanup.finish();
  expect(stopRoot).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledTimes(3);
  expect(kill).not.toHaveBeenCalled();
  expect(cleanup.diagnostics().status).toBe("unverified");
});

test("a valid snapshot with no descendants needs no retry or warning", () => {
  const root = { pid: 123, ppid: process.pid, pgid: 0, start: "same" };
  const read = vi.spyOn(tree, "observeProcessTable").mockReturnValue({ ok: true, source: "windows", elapsedMs: 1, skipped: 2, table: new Map([[root.pid, root]]) });
  const cleanup = processTreeCleanup(root.pid);
  cleanup.capture(); cleanup.finish();
  expect(read).toHaveBeenCalledOnce();
  expect(cleanup.diagnostics()).toEqual({ status: "observed", observations: [{ ok: true, phase: "before_eof", source: "windows", elapsedMs: 1, skipped: 2 }] });
  expect(cleanupFailureReason(cleanup.diagnostics())).toBeUndefined();
});

// oxlint-disable-next-line eslint/max-statements -- Capture and revalidate reused identities with an unrelated sentinel.
test("revalidation does not signal a reused descendant PID or an unrelated process", () => {
  const host = { pid: process.pid, ppid: process.ppid, pgid: 99, start: "host" };
  const root = { pid: 123, ppid: process.pid, pgid: 123, start: "root" };
  const tool = { pid: 456, ppid: 123, pgid: 456, start: "tool" };
  const initial = new Map([host, root, tool].map((entry) => [entry.pid, entry]));
  const current = new Map([host, { ...tool, ppid: 1, start: "reused" }, { pid: 789, ppid: process.pid, pgid: 99, start: "sentinel" }].map((entry) => [entry.pid, entry]));
  vi.spyOn(tree, "observeProcessTable").mockReturnValueOnce({ ok: true, source: "ps", elapsedMs: 1, skipped: 0, table: initial }).mockReturnValueOnce({ ok: true, source: "ps", elapsedMs: 1, skipped: 0, table: current });
  const signal = vi.spyOn(process, "kill").mockReturnValue(true);
  const cleanup = processTreeCleanup(root.pid);
  cleanup.capture(); cleanup.finish();
  expect(signal).not.toHaveBeenCalled();
});

test("native tree termination does not act on a root already reported exited", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await once(child, "exit");
  const taskkill = vi.mocked(execFile);
  taskkill.mockClear();
  const direct = vi.spyOn(child, "kill");
  killProcessTree(child);
  expect(taskkill).not.toHaveBeenCalled();
  expect(direct).not.toHaveBeenCalled();
});

// Give the tool an independent console on Windows too, and wait for its
// own readiness plus IPC disconnection before the root may be closed.
const nativeTree = String.raw`
  const tool = require('node:child_process').spawn(process.execPath, ['-e', "setTimeout(() => {}, 60000); process.send('ready', () => process.disconnect());"], {
    detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let ready = false;
  tool.once('message', (message) => { ready = message === 'ready'; });
  tool.once('disconnect', () => {
    if (!ready) { console.error('tool disconnected before readiness'); process.exit(1); }
    tool.unref();
    console.log(tool.pid);
  });
  process.stdin.resume();
  process.stdin.on('end', () => { console.log('hook-complete'); process.exit(0); });
`;

// oxlint-disable-next-line eslint/max-statements -- Real EOF, surviving descendant, diagnostics and independent cleanup form one regression.
test.each(["capture-fails", "retry-recovers", "revalidation-fails"])("native graceful shutdown and detached descendant: %s", async (scenario) => {
  const sentinel = spawnLineProcess(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
  const child = spawnLineProcess(process.execPath, ["-e", nativeTree], { killTree: true, shutdown: "stdin" });
  const ready = Promise.withResolvers<number>();
  const lines: string[] = [];
  child.onLine((line) => { lines.push(line); if (/^\d+$/u.test(line)) { ready.resolve(Number(line)); } });
  let tool: number | undefined = undefined;
  let sentinelExited = false;
  sentinel.onExit(() => { sentinelExited = true; });
  const exits: { code: number | null; reason: string | undefined }[] = [];
  child.onExit((code, reason) => { exits.push({ code, reason }); });
  try {
    tool = await ready.promise;
    expect(await gone(tool, 50), "the independent tool must be ready and alive before shutdown").toBe(false);
    const nativeRead = tree.observeProcessTable;
    const read = vi.spyOn(tree, "observeProcessTable");
    if (scenario === "capture-fails") { read.mockReturnValue(failure); }
    else if (scenario === "retry-recovers") { read.mockReturnValueOnce(failure).mockImplementation(nativeRead); }
    else { read.mockImplementationOnce(nativeRead).mockReturnValue(failure); }
    child.kill(); child.kill();
    expect(await child.exited).toBe(0);
    expect(lines).toContain("hook-complete");
    expect(exits).toHaveLength(1);
    const recovered = scenario === "retry-recovers";
    expect(child.diagnostics().cleanup?.status).toBe(recovered ? "observed" : "unverified");
    expect(exits[0]?.reason === undefined).toBe(recovered);
    expect(await gone(tool, recovered ? 5000 : 50)).toBe(recovered);
    expect(sentinelExited).toBe(false);
    const observations = child.diagnostics().cleanup?.observations ?? [];
    expect(observations.some((entry) => !entry.ok && entry.code === "ETIMEDOUT")).toBe(true);
    const readsBeforeLateKill = read.mock.calls.length;
    child.kill();
    expect(read.mock.calls).toHaveLength(readsBeforeLateKill);
  } finally {
    vi.restoreAllMocks();
    if (tool !== undefined) { try { process.kill(tool, "SIGKILL"); } catch { /* Already cleaned up. */ } }
    child.kill(); sentinel.kill();
    await Promise.all([child.exited, sentinel.exited]);
  }
});
