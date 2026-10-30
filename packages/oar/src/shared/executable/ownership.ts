import { execFileSync, type ChildProcess } from "node:child_process";
import { writeSync } from "node:fs";
import { descendantsOf, killEntries, observeProcessTable, type ProcessTable, type ProcessTableObservation } from "./process-tree.js";
import { cleanupFailureReason, type ProcessCleanupDiagnostics } from "./process-cleanup-diagnostics.js";

const ownedChildren = new Set<ChildProcess>();
let exitHookInstalled = false;
const pendingCleanups = new Set<(read: () => ProcessTableObservation) => ProcessCleanupDiagnostics>();

/** Keep captured identities owned after the root and its pipes have closed. */
export function trackPendingCleanup(finish: (read: () => ProcessTableObservation) => ProcessCleanupDiagnostics): () => void {
  pendingCleanups.add(finish);
  return () => { pendingCleanups.delete(finish); };
}

function warn(reason: string | undefined): void {
  if (reason === undefined) { return; }
  try { writeSync(2, `[oar] ${reason}\n`); } catch { /* Stderr may already be closed. */ }
}

function killOwnedProcess(child: ChildProcess, table: () => ProcessTable | undefined): void {
  try {
    if (child.pid !== undefined) {
      if (process.platform === "win32") {
        // A reaped Windows pid can already identify an unrelated process.
        if (child.exitCode !== null || child.signalCode !== null) { return; }
        // An exit listener cannot wait for an asynchronous taskkill. Bound
        // this synchronous cleanup too, and suppress its console output.
        execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore", timeout: 10_000, windowsHide: true,
        });
      } else {
        // Its descendants outside its group too, found below it only while
        // it runs: a reaped pid may already be someone else's.
        const current = child.exitCode === null && child.signalCode === null ? table() : undefined;
        if (current !== undefined) { killEntries(descendantsOf(current, child.pid), current); }
        process.kill(-child.pid, "SIGKILL");
      }
      return;
    }
  } catch {
    // An empty group or failed tree walk still permits a direct-child try.
  }
  try { child.kill("SIGKILL"); } catch { /* Continue with the other children. */ }
}

/**
 * Own a detached POSIX group or Windows tree until its output pipes close:
 * descendants may hold them after the launcher exits. One synchronous hook
 * covers sessions, probes, updaters, logins and ACP terminals when a host
 * calls process.exit without disposing them; on POSIX it also SIGKILLs the
 * descendants of a child still running that left its group, and their groups
 * (process-tree.ts). Node does not emit `exit` for an unhandled terminating
 * signal or SIGKILL; hosts own graceful handling.
 */
export function trackOwnedProcess(child: ChildProcess): void {
  ownedChildren.add(child);
  const forget = (): void => { ownedChildren.delete(child); };
  child.once("close", forget);
  child.once("error", () => {
    // Other errors (e.g. a failed kill) do not prove the process is gone.
    if (child.pid === undefined) { forget(); }
  });
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      // One read of the process table serves every child.
      let observation: ProcessTableObservation | null = null;
      const observe = (): ProcessTableObservation => {
        observation ??= observeProcessTable();
        return observation;
      };
      const warnings = new Set<string>();
      const remember = (reason: string | undefined): void => { if (reason !== undefined) { warnings.add(reason); } };
      for (const finish of pendingCleanups) { remember(cleanupFailureReason(finish(observe))); }
      const read = (): ProcessTable | undefined => {
        const result = observe();
        if (result.ok) { return result.table; }
        remember(cleanupFailureReason({ status: "unverified", observations: [{ ...result, phase: "before_force" }] }));
        return undefined;
      };
      for (const owned of ownedChildren) { killOwnedProcess(owned, read); }
      if (warnings.size > 0) { warn([...warnings].join("; ")); }
    });
  }
}
