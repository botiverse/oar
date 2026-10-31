import type { ChildProcess } from "node:child_process";
import { processTreeCleanup, cleanupFailureReason, type ProcessCleanupDiagnostics } from "./process-cleanup.js";
import { trackPendingCleanup } from "./ownership.js";
import { killGraceMs, killProcessTree, signalProcessGroup } from "./process-signals.js";

interface ShutdownOptions { readonly killTree?: boolean; readonly shutdown?: "stdin"; }

/** The root's exit and asynchronous cleanup form one owned, awaited lifetime. */
export function processShutdown(child: ChildProcess, options: ShutdownOptions): {
  readonly finished: Promise<void>;
  stop(): void;
  prepare(): Promise<void>;
  nativeExited(): void;
  stopping(): boolean;
  diagnostics(): ProcessCleanupDiagnostics | undefined;
  reason(): string | undefined;
} {
  let stopping = false;
  let ended = false;
  let phase: Promise<void> = Promise.resolve();
  let escalation: NodeJS.Timeout | undefined = undefined;
  let cleanup: ReturnType<typeof processTreeCleanup> | undefined = undefined;
  let capture: Promise<void> | undefined = undefined;
  let releaseCleanup: (() => void) | undefined = undefined;
  const nativeExit = Promise.withResolvers<void>();
  const alive = (): boolean => !ended && child.exitCode === null && child.signalCode === null;
  const stopRoot = (): void => {
    if (!alive()) { return; }
    if (process.platform === "win32" && options.killTree === true) { killProcessTree(child); }
    else { signalProcessGroup(child, "SIGKILL"); }
  };
  const force = async (): Promise<void> => {
    try {
      if (cleanup === undefined) { stopRoot(); }
      else { await cleanup.force(stopRoot); }
    } catch (error) {
      cleanup?.failed(error, "before_force");
      if (alive()) { try { child.kill("SIGKILL"); } catch { /* Native exit stays authoritative. */ } }
    }
  };
  const close = (): void => {
    if (!alive()) { return; }
    child.stdin?.end();
    // Pi reenters shutdown on EOF plus SIGTERM and skips its native hooks.
    if (options.shutdown !== "stdin") {
      if (process.platform === "win32" && options.killTree === true) { killProcessTree(child); }
      else { signalProcessGroup(child, "SIGTERM"); }
    }
    escalation = setTimeout(() => { phase = force(); }, killGraceMs());
  };
  const prepare = async (): Promise<void> => {
    if (capture !== undefined) { await capture; return; }
    if (!alive() || options.killTree !== true || child.pid === undefined) { return; }
    const ownedCleanup = processTreeCleanup(child.pid, alive);
    cleanup = ownedCleanup;
    releaseCleanup = trackPendingCleanup((read) => ownedCleanup.finishSync(read));
    capture = (async (): Promise<void> => {
      try { await ownedCleanup.capture(); }
      catch (error) { ownedCleanup.failed(error, "before_eof"); }
    })();
    phase = capture;
    await capture;
  };
  const captureAndClose = async (prepared: Promise<void>): Promise<void> => {
    await prepared;
    try { close(); }
    catch (error) { cleanup?.failed(error, "before_force"); await force(); }
  };
  const finish = async (): Promise<void> => {
    await nativeExit.promise;
    // Native exit can arrive during capture or force. Finish after that phase,
    // not concurrently with a mutation of the remembered identity set.
    await phase;
    try { await cleanup?.finish(); }
    catch (error) { cleanup?.failed(error, "after_exit"); }
    releaseCleanup?.();
  };
  const finished = finish();
  return {
    finished,
    prepare,
    stopping: () => stopping,
    diagnostics: () => cleanup?.diagnostics(),
    reason: () => cleanupFailureReason(cleanup?.diagnostics()),
    nativeExited() { ended = true; clearTimeout(escalation); nativeExit.resolve(); },
    stop() {
      if (!alive() || stopping) { return; }
      stopping = true;
      if (options.killTree !== true || child.pid === undefined) { close(); return; }
      // Capture before EOF/taskkill too: an intermediate Windows parent may
      // exit first, leaving tools outside taskkill's remaining parent chain.
      const prepared = prepare();
      phase = captureAndClose(prepared);
    },
  };
}
