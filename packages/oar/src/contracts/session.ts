import type { AvailableInstallation } from "./installation.js";

/**
 * Session/Turn contract v1. Behavior invariants live as comments on the
 * member they constrain; each "must/never" has (or gets) a sea-trial case.
 *
 * Scope notes that fit no single member:
 * - Ownership is the object reference; no in-process lease. Multi-controller
 *   arbitration belongs to the application layer.
 * - v1 defers resume/persistence, permission settlement (adapters run
 *   pre-approved/harness defaults), and any remote/multi-consumer model.
 * - pi emits session-scoped events (compaction_start/end, queue_update) that
 *   belong to no turn; representing those is a deliberate v2 decision
 *   (nullable turnId vs a second event scope). Until then adapters drop them.
 */

export interface SessionOptions {
  /** Working directory the runtime operates in. */
  readonly cwd: string;
  /** Runtime-native model identifier; the runtime's default when omitted. */
  readonly model?: string;
}

/**
 * Execution capability entrypoint; composition probes installation first.
 * Rejects only on operational failure (spawn/load/auth errors carry the
 * runtime's message).
 */
export type StartSession = (
  installation: AvailableInstallation,
  options: SessionOptions,
) => Promise<Session>;

export interface Session {
  readonly id: string;
  prompt(input: string): PromptResult; // ≤1 active turn: busy while one runs; NEVER queues implicitly
  subscribe(observer: SessionObserver): Unsubscribe; // side-tap: sync, never awaited; a throwing observer must not affect the run or other observers
  dispose(): Promise<void>; // aborts an active turn (its outcome settles aborted), releases the runtime; idempotent
}

export type PromptResult =
  | { readonly kind: "turn"; readonly turn: Turn }
  | { readonly kind: "busy" };

export type SessionObserver = (event: SessionEvent) => void;
export type Unsubscribe = () => void;

export interface Turn {
  readonly id: string; // handle binds intent to identity — steer/abort are race-checked at the runtime (codex: expectedTurnId)
  readonly outcome: Promise<TurnOutcome>; // settles exactly once; runtime-reported ends resolve, never reject
  abort(): Promise<void>; // no-op after the turn ended — a late abort is a normal race, not an error
  /**
   * Mid-turn input; absent when the runtime cannot inject into an active turn.
   * Applies at the next model-step boundary. During runtime-autonomous
   * compaction the input is HELD, not lost (codex resumes then drains; claude
   * runs it after the compaction turn); codex Compact/Review turns reject with
   * not_steerable instead. Where input landed is the event stream's job: same
   * turnId, or a fresh turn_started when claude auto-queues past a turn that
   * just ended (that spontaneous turn has events but no control handle yet).
   * Ack strength is documented, not typed: codex confirms into-active-turn,
   * pi confirms enqueue, claude confirms the write.
   */
  readonly steer?: (input: string) => Promise<SteerResult>;
}

export type TurnOutcome =
  | { readonly kind: "completed" }
  | { readonly kind: "aborted" }
  | { readonly kind: "failed"; readonly reason: string };

export type SteerResult =
  | { readonly kind: "accepted" }
  | { readonly kind: "not_steerable"; readonly reason: string };

/** Envelope + minimal body; runtime-specific detail waits for real demand. */
export type SessionEvent = SessionEventEnvelope & SessionEventBody;

export interface SessionEventEnvelope {
  readonly sessionId: string;
  readonly turnId: string;
  /** Monotonic per session; total order for trace alignment. */
  readonly seq: number;
  /** Unix epoch milliseconds stamped at adapter ingress — same clock as Date.now(), so fold×clock consumers (stallOf) compose directly. */
  readonly receivedAt: number;
}

export type SessionEventBody =
  | { readonly kind: "turn_started" }
  | { readonly kind: "text_delta"; readonly text: string }
  | { readonly kind: "thinking_delta"; readonly text: string }
  | { readonly kind: "tool_call_started"; readonly callId: string; readonly tool: string }
  | { readonly kind: "tool_call_ended"; readonly callId: string }
  | { readonly kind: "turn_ended"; readonly outcome: TurnOutcome };
