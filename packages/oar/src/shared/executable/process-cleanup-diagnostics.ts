import type { ProcessTableObservation } from "./process-tree.js";
import type { ProcessTablePreparation } from "./process-table-preparation.js";

export type Phase = "before_eof" | "before_cancel" | "before_force" | "after_exit";
export type Observation = (Exclude<ProcessTableObservation, { ok: true }> | {
  readonly ok: true;
  readonly source: ProcessTableObservation["source"];
  readonly elapsedMs: number;
  readonly skipped: number;
}) & { readonly phase: Phase };

/** Internal observations, not a guarantee that every descendant has exited. */
export interface ProcessCleanupDiagnostics {
  readonly status: "observed" | "unverified";
  readonly observations: readonly Observation[];
  /** Host preparation metadata captured after this process's cleanup finishes. */
  readonly preparation?: ProcessTablePreparation;
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

