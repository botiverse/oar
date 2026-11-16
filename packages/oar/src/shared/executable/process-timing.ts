import type { ProcessTableSource } from "./process-tree.js";

type Timing =
  | { readonly kind: "observation_requested"; readonly requestId: number; readonly source: ProcessTableSource; readonly deadlineMs: number }
  | { readonly kind: "observation_returned"; readonly requestId: number; readonly outcome: "ok" | "failed" | "timeout" }
  | { readonly kind: "query_joined"; readonly queryId: number; readonly requestId: number }
  | { readonly kind: "query_queued"; readonly queryId: number; readonly source: ProcessTableSource; readonly behindQueryId?: number }
  | { readonly kind: "query_started" | "query_skipped"; readonly queryId: number }
  | { readonly kind: "query_caller_expired"; readonly queryId: number; readonly requestId: number }
  | { readonly kind: "query_finished"; readonly queryId: number; readonly outcome: "ok" | "failed" }
  | { readonly kind: "cancel_requested" | "cancel_committed" | "cancel_completed"; readonly shutdownId: number; readonly requestId: number }
  | { readonly kind: "stop_requested" | "root_exited" | "cleanup_started" | "cleanup_finished"; readonly shutdownId: number };

/** Internal diagnostic events only. IDs are local sequence numbers, never PIDs.
 * All timestamps and deadlines use this process's performance.now() clock.
 * A finished cleanup means its work returned, not proof every process is gone. */
export type ProcessTiming = Timing & { readonly atMs: number };
const observers = new Set<(event: ProcessTiming) => void>();
let sequence = 0;
export function processTimingId(): number { sequence += 1; return sequence; }

/** No retained events or I/O in production. Subscribers own their bounds/lifetime. */
export function observeProcessTiming(observer: (event: ProcessTiming) => void): () => void {
  observers.add(observer);
  return () => { observers.delete(observer); };
}

export function processTiming(event: Timing, atMs?: number): void {
  if (observers.size === 0) { return; }
  const timed = { ...event, atMs: atMs ?? performance.now() };
  for (const observer of observers) {
    try { observer(timed); } catch { /* Diagnostics must not change cancellation or cleanup. */ }
  }
}
