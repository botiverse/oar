import type { ChildProcess } from "node:child_process";
import { trackPendingCleanup } from "./ownership.js";
import { observeProcessTableWithin } from "./process-table-budget.js";
import { descendantsOf, signalEntries, type ProcessEntry, type ProcessTableObservation } from "./process-tree.js";
import type { Observation, ProcessCleanupDiagnostics } from "./process-cleanup-diagnostics.js";

/**
 * Stop a POSIX probe without tying descendant ownership to its output pipes.
 * Resolves once the SIGKILL escalation has been sent (or found nothing to
 * send): what still holds the pipes then is out of OAR's reach.
 */
export async function stopProbe(child: ChildProcess, graceMs: number): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) { return; }
  const { promise: forced, resolve: escalated } = Promise.withResolvers<void>();
  let closed = false;
  let captured = false;
  let owned: readonly ProcessEntry[] = [];
  const observations: Observation[] = [];
  const alive = (): boolean => child.exitCode === null && child.signalCode === null;
  child.once("close", () => { closed = true; });
  const remember = (result: ProcessTableObservation): void => {
    captured = true;
    if (!result.ok || closed) { return; }
    const root = result.table.get(pid);
    if (alive() && root !== undefined) {
      owned = [root, ...descendantsOf(result.table, pid, result.source)];
    } else if (root === undefined) {
      // An exited launcher can leave tools holding its pipes. That still
      // owned group supplies identities only until close, never afterwards.
      owned = [...result.table.values()].filter(entry => entry.pgid === pid);
    }
  };
  const record = (result: ProcessTableObservation, phase: Observation["phase"]): void => {
    observations.push(result.ok
      ? { ok: true, phase, source: result.source, elapsedMs: result.elapsedMs, skipped: result.skipped }
      : { ...result, phase });
  };
  const force = (result: ProcessTableObservation): ProcessCleanupDiagnostics => {
    record(result, "before_force");
    if (!captured) { remember(result); }
    if (result.ok) {
      const entries = new Map<number, ProcessEntry>();
      for (const entry of owned) {
        if (result.table.get(entry.pid)?.start !== entry.start) { continue; }
        entries.set(entry.pid, entry);
        for (const descendant of descendantsOf(result.table, entry.pid, result.source)) { entries.set(descendant.pid, descendant); }
      }
      signalEntries(entries.values(), result.table);
    }
    // A failed table read permits a direct signal only to our still-live child.
    if (!result.ok && alive()) { child.kill("SIGKILL"); }
    owned = [];
    return { status: observations.some(entry => !entry.ok) ? "unverified" : "observed", observations: [...observations] };
  };
  // An unref'ed grace timer must not lose ownership if the host exits first.
  const forget = trackPendingCleanup(read => force(read()));
  const escalate = async (): Promise<void> => {
    try { force(await observeProcessTableWithin(5000, undefined, { background: true })); }
    finally { forget(); escalated(); }
  };
  void (async (): Promise<void> => {
    try {
      const before = await observeProcessTableWithin(5000, undefined, { background: true });
      record(before, "before_cancel");
      remember(before);
      if (before.ok) { signalEntries(owned, before.table, () => true, "SIGTERM"); }
      else if (alive()) { child.kill("SIGTERM"); }
    } finally {
      const escalation = setTimeout(() => { void escalate(); }, graceMs);
      escalation.unref();
    }
  })();
  await forced;
}
