import { observeProcessTableWithin } from "./process-table-budget.js";
import type { ProcessTableObservation } from "./process-tree.js";

/** Staged evidence only. Commit immediately before sending the native cancel;
 * complete when that same turn ends or its cancellation is refused. */
export interface CancellationObservation {
  commit(): void;
  complete(): void;
}

/** One fresh batched observation, with at most one second of caller waiting.
 * A shared query may still serve other callers; its late result is never used
 * for this cancellation and does not postpone native cancel dispatch. */
export async function observeBeforeCancellation(): Promise<ProcessTableObservation> {
  const result = await observeProcessTableWithin(1000);
  return result;
}
