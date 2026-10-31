import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { spawnLineProcess } from "../packages/oar/src/shared/executable/process.js";
import type { ProcessTableObservation } from "../packages/oar/src/shared/executable/process-tree.js";
// oxlint-disable-next-line import/no-namespace -- Control only the observation boundary, retaining actual root exit and cleanup.
import * as tables from "../packages/oar/src/shared/executable/process-table-async.js";
import { gone } from "./fixtures/process-tree.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const failure: ProcessTableObservation = { ok: false, source: "windows", reason: "timeout", elapsedMs: 5000, timeoutMs: 5000 };

// oxlint-disable-next-line eslint/max-statements -- Native exit is deliberately placed inside each asynchronous cleanup phase.
test.each(["capture", "force"])("LineProcess waits for pending %s after native exit and retains its diagnostics", async (phase) => {
  vi.stubEnv("OAR_KILL_GRACE_MS", "10");
  const child = spawnLineProcess(process.execPath, [fileURLToPath(new URL("fixtures/async-cleanup-tree.mjs", import.meta.url))], {
    killTree: true, shutdown: "stdin", env: { ...process.env, OAR_TREE_IGNORE_EOF: phase === "force" ? "1" : "0" },
  });
  const entered = Promise.withResolvers<void>(), ready = Promise.withResolvers<number>();
  const gate = Promise.withResolvers<ProcessTableObservation>();
  const exits: { code: number | null; reason: string | undefined }[] = [];
  child.onLine((line) => { if (/^\d+$/u.test(line)) { ready.resolve(Number(line)); } });
  child.onExit((code, reason) => { exits.push({ code, reason }); });
  let tool: number | undefined = undefined;
  let root: number | undefined = undefined;
  try {
    tool = await ready.promise;
    expect(await gone(tool, 50)).toBe(false);
    const initial = await tables.observeProcessTableAsync();
    expect(initial.ok).toBe(true);
    root = initial.ok ? initial.table.get(tool)?.ppid : undefined;
    if (root === undefined) { throw new Error("fixture root identity missing"); }
    let active = false, overlap = false;
    const nativeRead = tables.observeProcessTableAsync;
    const read = vi.spyOn(tables, "observeProcessTableAsync");
    if (phase === "force") { read.mockImplementationOnce(nativeRead); }
    read.mockImplementationOnce(async () => {
      active = true; entered.resolve();
      try { return await gate.promise; } finally { active = false; }
    }).mockImplementation(async () => { if (active) { overlap = true; } return nativeRead(); });
    child.kill();
    await entered.promise;
    if (phase === "capture") { child.markNativeStop(); child.stdin.end(); }
    else { process.kill(root, "SIGTERM"); }
    await vi.waitFor(() => { const { exitCode, signal } = child.diagnostics(); expect(exitCode !== null || signal !== null).toBe(true); }, { timeout: 5000 });
    await nextTurn();
    expect(exits).toEqual([]);
    expect(overlap).toBe(false);
    expect(read).toHaveBeenCalledTimes(phase === "capture" ? 1 : 2);
    gate.resolve(failure);
    await child.exited;
    expect(exits).toHaveLength(1);
    expect(exits[0]?.reason).toContain(`${phase === "capture" ? "before_eof" : "before_force"} windows: timeout`);
    expect(child.diagnostics().cleanup?.status).toBe("unverified");
    expect(overlap).toBe(false);
    expect(await gone(tool, phase === "force" ? 5000 : 50)).toBe(phase === "force");
  } finally {
    gate.resolve(failure); vi.restoreAllMocks();
    if (root !== undefined && child.diagnostics().exitCode === null && child.diagnostics().signal === null) { try { process.kill(root, "SIGKILL"); } catch { /* Already gone. */ } }
    child.kill(); await child.exited;
    if (tool !== undefined) { try { process.kill(tool, "SIGKILL"); } catch { /* Already reclaimed. */ } }
  }
});

// oxlint-disable-next-line eslint/max-statements -- A pending failed query must not reclassify a spontaneous native exit as OAR cleanup.
test.each(["prepare", "kill"])("natural exit during %s keeps the native result without a cleanup suffix", async (method) => {
  const child = spawnLineProcess(process.execPath, ["-e", "process.stdin.once('data', () => process.exit(7)); console.log('ready');"], { killTree: true });
  const ready = Promise.withResolvers<void>();
  child.onLine(() => { ready.resolve(); });
  const gate = Promise.withResolvers<ProcessTableObservation>();
  const exits: { code: number | null; reason: string | undefined }[] = [];
  child.onExit((code, reason) => { exits.push({ code, reason }); });
  try {
    await ready.promise;
    const read = vi.spyOn(tables, "observeProcessTableAsync").mockReturnValue(gate.promise);
    const prepared = method === "prepare" ? child.prepareShutdown() : undefined;
    if (method === "kill") { child.kill(); }
    expect(read).toHaveBeenCalledOnce();
    // This fixture exits itself while OAR has not sent EOF or a signal.
    child.stdin.write("fixture-exit");
    await vi.waitFor(() => { expect(child.diagnostics().exitCode).toBe(7); });
    expect(exits).toEqual([]);
    gate.resolve(failure);
    await prepared;
    expect(await child.exited).toBe(7);
    expect(exits).toEqual([{ code: 7, reason: undefined }]);
    expect(child.diagnostics().cleanup).toBeUndefined();
    expect(read).toHaveBeenCalledOnce();
  } finally {
    gate.resolve(failure); vi.restoreAllMocks(); child.kill(); await child.exited;
  }
});

// oxlint-disable-next-line eslint/max-statements -- Only an actual, still-active turn cancellation owns this native exit.
test.each(["staged", "active", "completed"])("%s cancellation observation scopes failure diagnostics to its own turn", async stage => {
  const child = spawnLineProcess(process.execPath, ["-e", "process.stdin.once('data', () => process.exit(7)); console.log('ready');"], { killTree: true });
  const ready = Promise.withResolvers<void>();
  child.onLine(() => { ready.resolve(); });
  const exits: { code: number | null; reason: string | undefined }[] = [];
  child.onExit((code, reason) => { exits.push({ code, reason }); });
  try {
    await ready.promise;
    const read = vi.spyOn(tables, "observeProcessTableAsync").mockRejectedValue(Object.assign(new Error("process table unavailable"), { code: "EIO" }));
    const observation = await child.observeCancellation();
    if (stage !== "staged") { observation.commit(); }
    if (stage === "completed") { observation.complete(); }
    child.write("fixture-native-exit");
    expect(await child.exited).toBe(7);
    expect(read).toHaveBeenCalledOnce();
    expect(exits).toHaveLength(1);
    if (stage === "active") { expect(exits[0]?.reason).toContain("before_cancel"); }
    else { expect(exits[0]?.reason).toBeUndefined(); expect(child.diagnostics().cleanup).toBeUndefined(); }
  } finally { vi.restoreAllMocks(); child.kill(); await child.exited; }
});
