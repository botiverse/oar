import { observeProcessTableAsync, processTableSource } from "./process-table-async.js";
import { processTableFailure, type ProcessTableObservation, type ProcessTableSource } from "./process-tree.js";
import type { ProcessTableReadOptions } from "./process-table-command.js";
import { processTiming, processTimingId } from "./process-timing.js";

/** Caller budget includes the queue. A late shared query may serve another
 * caller, but can never become this caller's identity evidence. */
export async function observeProcessTableWithin(timeoutMs: number, source: ProcessTableSource = processTableSource(), options?: ProcessTableReadOptions): Promise<ProcessTableObservation> {
  const started = performance.now();
  const requestId = options?.requestId ?? processTimingId();
  processTiming({ kind: "observation_requested", requestId, source, deadlineMs: started + timeoutMs }, started);
  const returned = (result: ProcessTableObservation): ProcessTableObservation => {
    processTiming({ kind: "observation_returned", requestId, outcome: result.ok ? "ok" : (result.reason === "timeout" ? "timeout" : "failed") });
    return result;
  };
  const timeout = (): ProcessTableObservation => ({ ok: false, source, reason: "timeout", timeoutMs, elapsedMs: performance.now() - started });
  if (timeoutMs <= 0) { return returned(timeout()); }
  const deadline = started + timeoutMs;
  const expired = Promise.withResolvers<ProcessTableObservation>();
  const timer = setTimeout(() => { expired.resolve(timeout()); }, timeoutMs);
  if (options?.background === true) { timer.unref(); }
  try {
    const read = (async (): Promise<ProcessTableObservation> => {
      try { return await observeProcessTableAsync(source, { ...options, deadline, requestId }); }
      catch (error) { return processTableFailure(error, source, performance.now() - started); }
    })();
    const result = await Promise.race([read, expired.promise]);
    // A busy event loop may deliver the query before an overdue timer.
    return returned(performance.now() >= deadline ? timeout() : result);
  } finally { clearTimeout(timer); }
}
