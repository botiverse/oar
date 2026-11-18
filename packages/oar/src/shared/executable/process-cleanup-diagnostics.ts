import type { ProcessTableObservation } from "./process-tree.js";
import type { ProcessTablePreparation } from "./process-table-preparation.js";

/** `pipe_holders`: the read that looks for processes holding an exited root's output pipes (pipe-close.ts). */
export type Phase = "before_eof" | "before_cancel" | "before_force" | "after_exit" | "pipe_holders";
export type Observation = (Exclude<ProcessTableObservation, { ok: true }> | {
  readonly ok: true;
  readonly source: ProcessTableObservation["source"];
  readonly elapsedMs: number;
  readonly skipped: number;
}) & { readonly phase: Phase };

/** One of the root's output pipes: `extra` is a line process's private pipe at fd 3. */
export type HeldPipe = "stdout" | "stderr" | "extra";

/**
 * OAR closed its end of some of the root's output pipes because they were
 * still open past the limit after the root's exit (pipe-close.ts). What a
 * holder writes to them afterwards is lost (it gets EPIPE or SIGPIPE), so
 * output read from them may be incomplete.
 */
export interface HeldPipes {
  /** How long OAR waited for the pipes after the root's exit (after the SIGKILL, for a stopped command). */
  readonly waitedMs: number;
  /** The pipes OAR closed. */
  readonly pipes: readonly HeldPipe[];
  /**
   * The processes still in the root's process group, which may hold them
   * (which pipe each holds is not known). Empty when none is seen: a holder
   * that left the group (another user's tree under `sudo -u`, a tool in a
   * session of its own) is not, nor is any when the table read failed.
   */
  readonly holders: readonly number[];
  /** The process-table read that failed, so no holder could be looked for. */
  readonly observation?: Observation;
}

/** Cleanup diagnostics with `heldPipes` added; a failed read for the holders makes them unverified and joins the observations. */
export function withHeldPipes(cleanup: ProcessCleanupDiagnostics | undefined, heldPipes: HeldPipes): ProcessCleanupDiagnostics;
export function withHeldPipes(cleanup: ProcessCleanupDiagnostics | undefined, heldPipes: HeldPipes | undefined): ProcessCleanupDiagnostics | undefined;
export function withHeldPipes(cleanup: ProcessCleanupDiagnostics | undefined, heldPipes: HeldPipes | undefined): ProcessCleanupDiagnostics | undefined {
  if (heldPipes === undefined) { return cleanup; }
  const base = cleanup ?? { status: "observed", observations: [] };
  const { observation, ...held } = heldPipes;
  return observation === undefined ? { ...base, heldPipes: held }
    : { ...base, status: "unverified", observations: [...base.observations, observation], heldPipes: held };
}

function heldPipesReason(held: HeldPipes): string {
  const who = held.holders.length === 0 ? "no holder identified" : `left in the root's process group: pids ${held.holders.join(", ")}`;
  return `Output pipes (${held.pipes.join(", ")}) still open ${String(held.waitedMs)} ms after the root exited (${who}); OAR closed its end, so output may be incomplete`;
}

/** Internal observations, not a guarantee that every descendant has exited. */
export interface ProcessCleanupDiagnostics {
  readonly status: "observed" | "unverified";
  readonly observations: readonly Observation[];
  /** Processes left holding the output pipes once the root had exited; OAR stopped waiting for them. */
  readonly heldPipes?: HeldPipes;
  /** Host preparation metadata captured after this process's cleanup finishes. */
  readonly preparation?: ProcessTablePreparation;
}

export function cleanupFailureReason(cleanup: ProcessCleanupDiagnostics | undefined): string | undefined {
  const held = cleanup?.heldPipes === undefined ? undefined : heldPipesReason(cleanup.heldPipes);
  if (cleanup?.status !== "unverified") { return held; }
  const reasons = cleanup.observations.filter((entry) => !entry.ok).map((entry) =>
    `${entry.phase} ${entry.source}: ${entry.reason} (${entry.elapsedMs.toFixed(0)} ms${entry.code === undefined ? "" : `, ${entry.code}`}${entry.exitCode === undefined ? "" : `, exit ${String(entry.exitCode)}`}${entry.signal === undefined ? "" : `, ${entry.signal}`})`);
  return `Descendant cleanup could not be verified: ${reasons.join("; ")}${held === undefined ? "" : `; ${held}`}`;
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

