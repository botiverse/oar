import { descendantsOf, killEntries, processTableFailure, type ProcessEntry, type ProcessTable, type ProcessTableObservation } from "./process-tree.js";
import { observeProcessTableAsync, processTableSource } from "./process-table-async.js";
import type { Observation, Phase, ProcessCleanupDiagnostics } from "./process-cleanup-diagnostics.js";

export { appendCleanupFailure, cleanupFailureReason, type ProcessCleanupDiagnostics } from "./process-cleanup-diagnostics.js";

/** Capture before EOF, then revalidate identities before signalling descendants. */
export function processTreeCleanup(pid: number, alive: () => boolean = () => true): {
  capture(): Promise<void>;
  force(stopRoot: () => void): Promise<void>;
  finish(): Promise<void>;
  finishSync(read: () => ProcessTableObservation): ProcessCleanupDiagnostics;
  failed(error: unknown, phase: Phase): void;
  diagnostics(): ProcessCleanupDiagnostics;
} {
  const observations: Observation[] = [];
  let unverified = false;
  let captured = false;
  let descendants: readonly ProcessEntry[] = [];
  let root: ProcessEntry | undefined = undefined;
  const diagnostics = (): ProcessCleanupDiagnostics => ({ status: unverified ? "unverified" : "observed", observations: [...observations] });
  const failed = (error: unknown, phase: Phase): void => {
    unverified = true;
    observations.push({ ...processTableFailure(error, processTableSource(), 0), phase });
  };
  const accept = (result: ProcessTableObservation, phase: Phase): ProcessTable | undefined => {
    if (!result.ok) { observations.push({ ...result, phase }); return undefined; }
    if (phase === "before_eof" && (!alive() || !result.table.has(pid))) {
      observations.push({ ok: false, phase, source: result.source, elapsedMs: result.elapsedMs, reason: "missing_root" });
      return undefined;
    }
    observations.push({ ok: true, phase, source: result.source, elapsedMs: result.elapsedMs, skipped: result.skipped });
    return result.table;
  };
  const read = async (phase: Phase): Promise<ProcessTable | undefined> => {
    try { return accept(await observeProcessTableAsync(), phase); }
    catch (error) { failed(error, phase); return undefined; }
  };
  return {
    async capture() {
      // At most two reads (one retry), both before EOF. A root that exited
      // during a read cannot lend its possibly reused PID to a retry.
      let table = await read("before_eof");
      if (table === undefined && alive()) { table = await read("before_eof"); }
      if (table === undefined) { unverified = true; return; }
      captured = true;
      root = table.get(pid);
      descendants = descendantsOf(table, pid);
    },
    async force(stopRoot) {
      const table = await read("before_force");
      // Read failure still permits stopping the live owned root, but never
      // signalling a remembered descendant without matching its identity.
      stopRoot();
      if (table === undefined) { unverified = true; return; }
      const current = table.get(pid);
      const now = root !== undefined && current?.start === root.start ? descendantsOf(table, pid) : [];
      killEntries([...descendants, ...now], table);
      descendants = [];
    },
    async finish() {
      if (descendants.length === 0) { return; }
      const table = await read("after_exit");
      if (table === undefined) { unverified = true; }
      else { killEntries(descendants, table); }
      descendants = [];
    },
    finishSync(readNow) {
      // The host may exit after child.close while an async observation is
      // pending. Revalidate known identities synchronously, never its cache.
      const phase = alive() ? "before_force" : "after_exit";
      const table = accept(readNow(), phase);
      if (table === undefined) { unverified = true; return diagnostics(); }
      if (!captured && !alive()) {
        unverified = true;
        observations.push({ ok: false, phase: "before_eof", source: processTableSource(), elapsedMs: 0, reason: "missing_root" });
      }
      const current = table.get(pid);
      const now = current !== undefined && (root === undefined ? alive() : current.start === root.start) ? descendantsOf(table, pid) : [];
      killEntries([...descendants, ...now], table);
      descendants = [];
      return diagnostics();
    },
    failed,
    diagnostics,
  };
}
