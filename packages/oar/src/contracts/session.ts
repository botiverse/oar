import type { AvailableInstallation } from "./installation.js";

/**
 * DRAFT SCAFFOLD — file framework only. Every shape below is a starting point
 * for review, not a settled contract; nothing here is exported from the public
 * package surface yet, and `Runtime.session` is `@internal` until the design
 * settles.
 *
 * Settled inputs this draft is built on (see work log 2026-08-21):
 * - one high-level Turn per submitted user run, with a first-class id
 * - events carry sessionId/turnId/seq and an ingress hrtime timestamp
 * - observation is a sync, never-awaited side-tap with multi-subscribe
 * - static capability = optional field presence; dynamic refusal = result union
 * - mid-turn steer is native-only; next-turn queue prefers native passthrough
 * - v1 defers resume/persistence, permission settlement, and remote/lease
 */

export interface SessionOptions {
  /** Working directory the runtime operates in. */
  readonly cwd: string;
}

/** Execution capability entrypoint: composition probes installation first. */
export type StartSession = (
  installation: AvailableInstallation,
  options: SessionOptions,
) => Promise<Session>;

export interface Session {
  readonly id: string;
  /**
   * Submit one user run. Open question: reject or auto-queue when a turn is
   * already active — leaning reject, with queueing an explicit capability.
   */
  prompt(input: string): Turn;
  /** Side-tap: observers are called synchronously, never awaited, must not throw. */
  subscribe(observer: (event: SessionEvent) => void): () => void;
  dispose(): Promise<void>;
}

export interface Turn {
  readonly id: string;
  /** Settles exactly once with the terminal outcome; never rejects for a runtime-reported end. */
  readonly outcome: Promise<TurnOutcome>;
  abort(): Promise<void>;
  /** Mid-turn steering; absent when the runtime cannot inject into an active turn. */
  readonly steer?: (input: string) => Promise<SteerResult>;
}

export type TurnOutcome =
  | { readonly kind: "completed" }
  | { readonly kind: "aborted" }
  | { readonly kind: "failed"; readonly reason: string };

export type SteerResult =
  | { readonly kind: "steered" }
  | { readonly kind: "not_steerable"; readonly reason: string };

/**
 * Minimal v1 event union. Deliberately shallow: runtime-specific detail rides
 * in adapter-owned payloads once real adapters demand it.
 */
export type SessionEvent = SessionEventEnvelope & SessionEventBody;

export interface SessionEventEnvelope {
  readonly sessionId: string;
  readonly turnId: string;
  /** Monotonic per session; total order for trace alignment. */
  readonly seq: number;
  /** process.hrtime.bigint()-derived milliseconds at adapter ingress. */
  readonly receivedAt: number;
}

export type SessionEventBody =
  | { readonly kind: "turn_started" }
  | { readonly kind: "text_delta"; readonly text: string }
  | { readonly kind: "thinking_delta"; readonly text: string }
  | { readonly kind: "tool_call_started"; readonly callId: string; readonly tool: string }
  | { readonly kind: "tool_call_ended"; readonly callId: string }
  | { readonly kind: "turn_ended"; readonly outcome: TurnOutcome };
