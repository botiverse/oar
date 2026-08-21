import type { AvailableInstallation } from "./installation.js";

/**
 * Session/Turn contract v1.
 *
 * Invariants (settled 2026-08-21; see the session-design thread):
 * - At most one active turn per session. `prompt` during an active turn
 *   returns a typed busy result; implicit queueing never happens.
 * - Ownership is the object reference; no in-process lease. Turn handles bind
 *   intent to identity, so steer/abort are structurally race-checked at the
 *   runtime (codex: expectedTurnId).
 * - Terminal idempotence: abort on an ended turn is a typed no-op, outcomes
 *   settle exactly once, dispose aborts an active turn and is idempotent.
 * - Observation is a side-tap: observers run synchronously, are never awaited,
 *   and a throwing observer must not affect the run or other observers.
 * - v1 defers resume/persistence, permission settlement (adapters run
 *   pre-approved/harness defaults), and any remote/multi-consumer model.
 */

export interface SessionOptions {
  /** Working directory the runtime operates in. */
  readonly cwd: string;
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
  /** Submit one user run. Busy while another turn is active — never queues implicitly. */
  prompt(input: string): PromptResult;
  /** Side-tap: sync fan-out, never awaited; observer errors are swallowed. */
  subscribe(observer: SessionObserver): Unsubscribe;
  /** Aborts an active turn, releases the runtime, idempotent. */
  dispose(): Promise<void>;
}

export type PromptResult =
  | { readonly kind: "turn"; readonly turn: Turn }
  | { readonly kind: "busy" };

export type SessionObserver = (event: SessionEvent) => void;
export type Unsubscribe = () => void;

export interface Turn {
  readonly id: string;
  /** Settles exactly once; runtime-reported ends resolve (never reject). */
  readonly outcome: Promise<TurnOutcome>;
  /** Typed no-op after the turn ended (a late abort is normal, not an error). */
  abort(): Promise<void>;
  /**
   * Mid-turn input, absent when the runtime cannot inject into an active turn.
   * Timing is always "next model-step boundary"; where the input landed is the
   * event stream's job to show (same turnId, or a fresh turn_started when a
   * runtime like claude auto-queues past a turn that just ended). Ack strength
   * differs per runtime and is documented, not typed: codex confirms
   * into-active-turn, pi confirms enqueue, claude confirms the write.
   * Known gap, deliberate: a turn a runtime starts on its own (claude
   * auto-queue landing) has events but no control handle until a real
   * application needs one.
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
  /** Milliseconds since the session started, stamped at adapter ingress. */
  readonly receivedAt: number;
}

export type SessionEventBody =
  | { readonly kind: "turn_started" }
  | { readonly kind: "text_delta"; readonly text: string }
  | { readonly kind: "thinking_delta"; readonly text: string }
  | { readonly kind: "tool_call_started"; readonly callId: string; readonly tool: string }
  | { readonly kind: "tool_call_ended"; readonly callId: string }
  | { readonly kind: "turn_ended"; readonly outcome: TurnOutcome };
