import { observeProcessTableAsync, processTableSource } from "./process-table-async.js";
import { processTableFailure, type ProcessTableObservation } from "./process-tree.js";

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
  const started = performance.now();
  const expired = Promise.withResolvers<ProcessTableObservation>();
  const timer = setTimeout(() => { expired.resolve({ ok: false, source: processTableSource(),
    reason: "timeout", timeoutMs: 1000, elapsedMs: performance.now() - started }); }, 1000);
  try {
    const read = (async (): Promise<ProcessTableObservation> => {
      try { return await observeProcessTableAsync(); }
      catch (error) { return processTableFailure(error, processTableSource(), performance.now() - started); }
    })();
    return await Promise.race([read, expired.promise]);
  } finally { clearTimeout(timer); }
}
