import { observeProcessTableAsync, processTableSource } from "./process-table-async.js";
import { processTableFailure, type ProcessTableObservation, type ProcessTableSource } from "./process-tree.js";

/** Caller budget includes the queue. A late shared query may serve another
 * caller, but can never become this caller's identity evidence. */
export async function observeProcessTableWithin(timeoutMs: number, source: ProcessTableSource = processTableSource()): Promise<ProcessTableObservation> {
  const started = performance.now();
  const timeout = (): ProcessTableObservation => ({ ok: false, source, reason: "timeout", timeoutMs, elapsedMs: performance.now() - started });
  if (timeoutMs <= 0) { return timeout(); }
  const expired = Promise.withResolvers<ProcessTableObservation>();
  const timer = setTimeout(() => { expired.resolve(timeout()); }, timeoutMs);
  try {
    const read = (async (): Promise<ProcessTableObservation> => {
      try { return await observeProcessTableAsync(source); }
      catch (error) { return processTableFailure(error, source, performance.now() - started); }
    })();
    const result = await Promise.race([read, expired.promise]);
    // A busy event loop may deliver the query before an overdue timer.
    return performance.now() - started >= timeoutMs ? timeout() : result;
  } finally { clearTimeout(timer); }
}
