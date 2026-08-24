import type { AvailableInstallation } from "./installation.js";

/**
 * Session/Turn contract v1. Behavior invariants live as comments on the
 * member they constrain; each "must/never" has (or gets) a sea-trial case.
 *
 * Scope notes that fit no single member:
 * - Ownership is the object reference; no in-process lease. Multi-controller
 *   arbitration belongs to the application layer.
 * - Sessions run YOLO by default: adapters disable interactive permission
 *   gates (claude --dangerously-skip-permissions, codex approvalPolicy
 *   never, pi pre-trusted cwd). In embedded use nobody sits at an approval
 *   prompt — a gate is a hang, not safety; isolation belongs to sandboxing
 *   (codex sandboxMode / OAR_CODEX_SANDBOX), not approval flows.
 * - v1 defers resume/persistence, interactive permission settlement, and any
 *   remote/multi-consumer model.
 * - pi emits session-scoped events (compaction_start/end, queue_update) that
 *   belong to no turn; representing those is a deliberate v2 decision
 *   (nullable turnId vs a second event scope). Until then adapters drop them.
 */

export interface SessionOptions {
  /** Working directory the runtime operates in. */
  readonly cwd: string;
  /** Runtime-native model identifier; the runtime's default when omitted. */
  readonly model?: string;
  /** Resume the runtime-native session identified by a previous Session.id. */
  readonly resume?: string;
  /** Extra environment overlaid on the host env for the processes THIS session spawns. Subprocess runtimes: the runtime process itself (tools inherit). In-process runtimes: only the agent's tool subprocesses — provider config needs the runtime's native channel there. CAVEAT for PATH-like entries: a runtime that runs tools through a login shell (codex: zsh/bash -lc) lets profile scripts reorder or rebuild PATH — probed: codex demotes injected entries on Linux and macOS path_helper/.zprofile can drop them. Injected CLIs should be invoked by ABSOLUTE path. */
  readonly env?: Readonly<Record<string, string>>;
  /** REPLACE the runtime's built-in system prompt (claude --system-prompt, codex thread baseInstructions, pi resource-loader systemPrompt). Survives runtime compaction — pinned per vendor. */
  readonly systemPrompt?: string;
  /** APPEND to the runtime's built-in system prompt, keeping its harness behavior intact (claude --append-system-prompt, codex developerInstructions, pi appendSystemPrompt). Survives runtime compaction — pinned per vendor. */
  readonly appendSystemPrompt?: string;
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

/**
 * The SPI face: what an adapter actually builds. Today every member is also
 * public, so the API face extends this; if an SPI-internal member ever
 * appears, the extends breaks into an explicit mapping inside sealSession —
 * that seam is already the only place the two faces meet.
 */
export interface AdapterSession {
  readonly id: string; // runtime-native persistent identity — pass to SessionOptions.resume to reattach later
  prompt(input: string): PromptResult; // ≤1 active turn: busy while one runs; NEVER queues implicitly
  subscribe(observer: SessionObserver): Unsubscribe; // side-tap: sync, never awaited; a throwing observer must not affect the run or other observers
  readonly queue?: TurnQueue; // next-turn input; absent only when a runtime cannot even hold input for later
  dispose(): Promise<void>; // aborts an active turn (its outcome settles aborted), releases the runtime; idempotent
}

/** The API face: the SPI plus surfaces sealSession derives. */
export interface Session extends AdapterSession {
  /**
   * DERIVED, not adapter-implemented: steer when the runtime can, fall back to
   * queueing, always report where the input landed. `rejected` means the input
   * was NOT taken over and the caller still owns it.
   */
  steerOrQueue(turn: Turn, input: string): Promise<SteerOrQueueResult>;
}

export type SteerOrQueueResult =
  | { readonly landed: "steered" }
  | { readonly landed: "queued" }
  | { readonly landed: "rejected"; readonly reason: string };

/**
 * Queue input to run as a future turn. `add` follows the same weak
 * delivery-obligation transfer as steer's accepted: the adapter (or runtime)
 * now owns not losing it; whether that survives a process restart is what
 * `durable` reports honestly (codex: runtime-persisted; claude/pi: held in
 * this process only).
 */
export interface TurnQueue {
  readonly durable: boolean;
  add(input: string): Promise<void>;
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
   * `accepted` is ONE deliberately weak promise, identical on every runtime:
   * the adapter has taken over this input and the caller's delivery
   * obligation ENDS — do not resubmit. Taking over means the adapter now owns
   * not losing it (e.g. holding it through runtime-autonomous compaction);
   * failure to take over is a typed not_steerable or a thrown operational
   * error, never a silent drop. No guarantee it lands in the current turn,
   * that the model attends to it, or that any business outcome happened. How
   * acceptance happens (stdin write, native enqueue, a runtime-side steer
   * ack) is adapter-internal and adapter-tested, never an application-facing
   * difference. Input written during
   * runtime-autonomous compaction is HELD, not lost; codex Compact/Review
   * turns reject with not_steerable instead. Where input landed is the event
   * stream's job: same turnId, or a fresh turn_started when a runtime
   * auto-queues past a turn that just ended (that spontaneous turn has events
   * but no control handle yet).
   */
  readonly steer?: (input: string) => Promise<SteerResult>;
}

/** Coarse failure classification so applications can react (re-login, back off, report a bug) without parsing vendor error prose. Best-effort: adapters map what the runtime reveals; "unknown" is an honest answer. */
export type FailureClass =
  | "auth"
  | "quota"
  | "invalid_request"
  | "overloaded"
  | "provider"
  | "runtime_exited"
  | "unknown";

export type TurnOutcome =
  | { readonly kind: "completed" }
  | { readonly kind: "aborted" }
  | { readonly kind: "failed"; readonly reason: string; readonly failure: FailureClass };

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

export type ReasoningContent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "redacted" }
  | { readonly kind: "empty" };

export type SessionEventBody =
  | { readonly kind: "turn_started" }
  | { readonly kind: "text_delta"; readonly text: string }
  /** A reasoning output item; its lifecycle remains observable without readable contents. */
  | { readonly kind: "reasoning"; readonly content: ReasoningContent }
  | {
      readonly kind: "tool_call_started";
      readonly callId: string;
      readonly tool: string;
      /** Best-effort human-readable invocation detail when the runtime exposes it. */
      readonly input?: string;
    }
  | {
      readonly kind: "tool_call_ended";
      readonly callId: string;
      /** Best-effort human-readable result detail when the runtime exposes it. */
      readonly output?: string;
    }
  | { readonly kind: "turn_ended"; readonly outcome: TurnOutcome };
