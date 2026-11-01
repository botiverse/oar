import { observeProcessTableAsync, processTableSource } from "./process-table-async.js";
import { processTableFailure, type ProcessTableObservation, type ProcessTableSource } from "./process-tree.js";
import type { ProcessTableReadOptions } from "./process-table-command.js";

/** Caller budget includes the queue. A late shared query may serve another
 * caller, but can never become this caller's identity evidence. */
export async function observeProcessTableWithin(timeoutMs: number, source: ProcessTableSource = processTableSource(), options?: ProcessTableReadOptions): Promise<ProcessTableObservation> {
  const started = performance.now();
  const timeout = (): ProcessTableObservation => ({ ok: false, source, reason: "timeout", timeoutMs, elapsedMs: performance.now() - started });
  if (timeoutMs <= 0) { return timeout(); }
  const deadline = started + timeoutMs;
  const expired = Promise.withResolvers<ProcessTableObservation>();
  const timer = setTimeout(() => { expired.resolve(timeout()); }, timeoutMs);
  if (options?.background === true) { timer.unref(); }
  try {
    const read = (async (): Promise<ProcessTableObservation> => {
      try { return await observeProcessTableAsync(source, { ...options, deadline }); }
      catch (error) { return processTableFailure(error, source, performance.now() - started); }
    })();
    const result = await Promise.race([read, expired.promise]);
    // A busy event loop may deliver the query before an overdue timer.
    return performance.now() >= deadline ? timeout() : result;
  } finally { clearTimeout(timer); }
}
