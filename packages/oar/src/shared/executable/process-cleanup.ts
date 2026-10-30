import { descendantsOf, killEntries, observeProcessTable, type ProcessEntry, type ProcessTable, type ProcessTableObservation } from "./process-tree.js";

type Phase = "before_eof" | "before_force" | "after_exit";
type Observation = (Exclude<ProcessTableObservation, { ok: true }> | {
  readonly ok: true;
  readonly source: ProcessTableObservation["source"];
  readonly elapsedMs: number;
  readonly skipped: number;
}) & { readonly phase: Phase };

/** Internal observations, not a guarantee that every descendant has exited. */
export interface ProcessCleanupDiagnostics {
  readonly status: "observed" | "unverified";
  readonly observations: readonly Observation[];
}

export function cleanupFailureReason(cleanup: ProcessCleanupDiagnostics | undefined): string | undefined {
  if (cleanup?.status !== "unverified") { return undefined; }
  const reasons = cleanup.observations.filter((entry) => !entry.ok).map((entry) =>
    `${entry.phase} ${entry.source}: ${entry.reason} (${entry.elapsedMs.toFixed(0)} ms${entry.code === undefined ? "" : `, ${entry.code}`}${entry.exitCode === undefined ? "" : `, exit ${String(entry.exitCode)}`}${entry.signal === undefined ? "" : `, ${entry.signal}`})`);
  return `Descendant cleanup could not be verified: ${reasons.join("; ")}`;
}

/** Keep a startup error's native class, code and cause when cleanup also failed. */
export function appendCleanupFailure(error: unknown, reason: string | undefined): unknown {
  if (reason === undefined) { return error; }
  const failure = error instanceof Error ? error : new Error(String(error));
  if (!failure.message.includes(reason)) {
    failure.message += `; ${reason}`;
    if (failure.stack !== undefined) { failure.stack += `\nCleanup: ${reason}`; }
  }
  return failure;
}

/** Capture before EOF, then revalidate identities before signalling descendants. */
export function processTreeCleanup(pid: number): {
  capture(): void;
  force(stopRoot: () => void): void;
  finish(): void;
  diagnostics(): ProcessCleanupDiagnostics;
} {
  const observations: Observation[] = [];
  let unverified = false;
  let descendants: readonly ProcessEntry[] = [];
  let root: ProcessEntry | undefined = undefined;
  const read = (phase: Phase): ProcessTable | undefined => {
    const result = observeProcessTable();
    if (!result.ok) {
      observations.push({ ...result, phase });
      return undefined;
    }
    if (phase === "before_eof" && !result.table.has(pid)) {
      observations.push({ ok: false, phase, source: result.source, elapsedMs: result.elapsedMs, reason: "missing_root" });
      return undefined;
    }
    observations.push({ ok: true, phase, source: result.source, elapsedMs: result.elapsedMs, skipped: result.skipped });
    return result.table;
  };
  return {
    capture() {
      // One bounded retry before closing stdin preserves native shutdown hooks
      // and keeps both observations. A later read cannot reconstruct reparented descendants.
      const table = read("before_eof") ?? read("before_eof");
      if (table === undefined) { unverified = true; return; }
      root = table.get(pid);
      descendants = descendantsOf(table, pid);
    },
    force(stopRoot) {
      const table = read("before_force");
      // A failed observation never prevents stopping the owned root. It does
      // prevent signalling remembered PIDs without checking their identities.
      stopRoot();
      if (table === undefined) { unverified = true; return; }
      const current = table.get(pid);
      const now = root !== undefined && current?.start === root.start ? descendantsOf(table, pid) : [];
      killEntries([...descendants, ...now], table);
      descendants = [];
    },
    finish() {
      if (descendants.length === 0) { return; }
      const table = read("after_exit");
      if (table === undefined) { unverified = true; }
      else { killEntries(descendants, table); }
      descendants = [];
    },
    diagnostics: () => ({ status: unverified ? "unverified" : "observed", observations: [...observations] }),
  };
}
