import type { Frame, RejectionCode, RequestRecord, ResponseRecord } from "./records.js";

/** Adapter declaration before opening; absence means unmeasured, not unsupported. */
export type ManualCompaction =
  | { readonly kind: "supported"; readonly activeTurn: "reject" | "queue" }
  | { readonly kind: "unsupported"; readonly reason: string };

/** An already-aborted signal refuses dispatch. After dispatch these bounds stop observation only; timeoutMs: 0 still dispatches. */
export interface CompactionOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

interface CompactionEvidence {
  readonly request: RequestRecord;
  /** Absent when observation ended before the native admission answer. */
  readonly response?: ResponseRecord;
}

/** A completed call requires native completion, not delivery or a successful ordinary turn. */
export type CompactionOutcome = CompactionEvidence & (
  | { readonly kind: "completed"; readonly frame: Frame }
  | { readonly kind: "aborted"; readonly frame: Frame }
  | { readonly kind: "rejected"; readonly response: ResponseRecord; readonly code: RejectionCode; readonly reason: string }
  | { readonly kind: "failed"; readonly code: "native_failed" | "not_compacted" | "command_changed"; readonly reason: string; readonly frame?: Frame }
  | { readonly kind: "unconfirmed"; readonly code: "timeout" | "signal" | "disposed" | "runtime_exited" | "session_released" | "observation_failed"; readonly reason: string }
);
