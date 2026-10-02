import type {
  ContextUsage,
  Cursor,
  Event,
  RawEvent,
  RejectionCode,
  RequestRecord,
  ResponseRecord,
  SessionGraph,
  TokenTotals,
} from "./records.js";
import type { DeliverOptions, DeliverResult } from "./deliver.js";
import type { InputImage, InputOrigin } from "./input.js";
import type { AgentStatus } from "./status.js";
import type { AvailableInstallation } from "./installation.js";

export type {
  ContextUsage,
  ControlAction,
  ControlEventBody,
  Cursor,
  Event,
  EventBody,
  FailureClass,
  Frame,
  FrameBody,
  ReasoningContent,
  RecordEnvelope,
  RecordKind,
  RejectionCode,
  RequestBody,
  RequestDirection,
  RequestRecord,
  ResponseBody,
  ResponseRecord,
  RuntimeEventBody,
  UserMessage,
  SessionEdge,
  SessionGraph,
  SessionNode,
  RawEvent,
  TokenTotals,
  TurnOutcome,
  UsageReport,
} from "./records.js";
export type { TaskEventBody, TaskStatus, TaskType } from "./tasks.js";
export type { AgentStatus, RunningPhase } from "./status.js";
export type { InputImage, InputOrigin } from "./input.js";
export type { DeliverOptions, DeliverResult, DeliverWhen } from "./deliver.js";

export interface QueryResult<T> {
  /** The fold's current value. */
  readonly value: T;
  /** The seq of the last consumed record, or -1 before any record. */
  readonly seq: number;
}

export interface InputOptions {
  /** UUID identifying one logical input across delivery attempts; generated when omitted. */
  readonly inputId?: string;
  /**
   * Images that travel with the text, as the runtime's own image input (not a
   * path in prose). Each is a file on this machine, read when the input is
   * delivered; the request record keeps the paths, never the bytes. Rejected
   * `unsupported` when `capabilities.images` is false.
   */
  readonly images?: readonly InputImage[];
  /** Who the input comes from; kept on the request record, never sent to the runtime. */
  readonly origin?: InputOrigin;
}


/**
 * Session contract: one ordered, resumable record stream.
 *
 * The external promise (docs/spec): everything the runtime said is in the
 * stream, nothing oar didn't observe is in it, every record knows whose it
 * is, and the stream is readable again from any position. Records split by
 * OBLIGATION into three kinds, frame (the runtime's own words), request (an
 * action that expects an outcome) and response (points at a request), and
 * travel on one channel with one monotonic `seq`. Consumers who do not want
 * records read the stream as flat `Event`s through `events()`; `rawEvents()`
 * and `records()` are the stream itself. Behavior invariants live as
 * comments on the member they constrain; each "must/never" has (or gets) a
 * sea-trial case.
 *
 * Scope notes that fit no single member:
 * - Ownership is the object reference; no in-process lease. Multi-controller
 *   arbitration belongs to the application layer.
 * - Sessions run YOLO by default: adapters disable interactive permission
 *   gates (claude --dangerously-skip-permissions, codex approvalPolicy
 *   never, pi pre-trusted cwd, ACP allow_always) AND default sandboxes off
 *   (codex danger-full-access; claude/pi have none). In embedded use nobody
 *   sits at an approval prompt: a gate is a hang, not safety. A host wanting
 *   isolation opts in (OAR_CODEX_SANDBOX). Runtime→app requests that DO
 *   arrive are recorded verbatim (direction "toApp") and oar's automatic
 *   answer, when it gives one, is the matching response record.
 * - The cursor is honored for the lifetime of the adapter process: a
 *   subscriber reconnecting with `afterSeq` misses nothing and repeats
 *   nothing. `SessionOptions.resume` reopens the runtime-native conversation
 *   with a fresh stream starting at seq 0.
 */

export interface SessionOptions {
  /** Working directory the runtime operates in. */
  readonly cwd: string;
  /** Runtime-native model identifier; the runtime's default when omitted. */
  readonly model?: string;
  /**
   * Runtime-native reasoning-effort level for every turn of this Session, one
   * of the chosen model's `ModelEntry.effortLevels`. Applied at open, with or
   * without `resume`: a resumed session runs at the level given here. When
   * omitted the runtime chooses (its default, or on resume what it restores;
   * the runtime pages say which).
   *
   * Invariant: a runtime whose `listModels` reports `effortLevels` accepts
   * `effort`, and a runtime that accepts it lists the levels. A requested
   * effort is never ignored: the adapter applies it through the runtime's
   * native channel and reads the runtime's own report back. When the runtime
   * refuses the level, or would run another one (drop it for the model, clamp
   * it, fall back to its default), or has no effort channel at all, starting
   * the session rejects with an Error naming the requested level and what the
   * runtime did instead. A runtime that forwards the level unchecked (codex)
   * reads it back as given, and its provider's refusal fails the first turn.
   * `Session.effort()` is the runtime's report, where it gives one.
   */
  readonly effort?: string;
  /** Resume the runtime-native session identified by a previous Session.id. */
  readonly resume?: string;
  /** Extra environment overlaid on the host env for the processes THIS session spawns. Subprocess runtimes: the runtime process itself (tools inherit). In-process runtimes: only the agent's tool subprocesses; provider config needs the runtime's native channel there. CAVEAT for PATH-like entries: a runtime that runs tools through a login shell (codex: zsh/bash -lc) lets profile scripts reorder or rebuild PATH (probed: codex demotes injected entries on Linux and macOS path_helper/.zprofile can drop them). Injected CLIs should be invoked by ABSOLUTE path. */
  readonly env?: Readonly<Record<string, string>>;
  /** REPLACE the runtime's built-in system prompt (claude --system-prompt, codex thread baseInstructions, pi resource-loader systemPrompt). Survives runtime compaction (pinned per vendor). */
  readonly systemPrompt?: string;
  /** APPEND to the runtime's built-in system prompt, keeping its harness behavior intact (claude --append-system-prompt, codex developerInstructions, pi appendSystemPrompt). Survives runtime compaction (pinned per vendor). */
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

// ─── Control surface ──────────────────────────────────────────────────────

/** Both records a control call produced: the request (its `seq` is where the action sits in the stream) and the accept/reject response. What an adapter returns (the SPI face). */
export interface ControlResult {
  readonly request: RequestRecord;
  readonly response: ResponseRecord;
}

/**
 * What `Session.prompt / steer / queue / abort` return (the API face): the
 * answer read off the two records, with the records still underneath. A
 * consumer branches on `kind` (two cases, not the four a response body can
 * carry) and on the typed `code`; `seq` is the request's position in the
 * stream, what `awaitTurnEnd` takes. `request` / `response` remain for
 * consumers who want the stream's own word (`native`, the exact records).
 */
export type ControlOutcome =
  | (ControlResult & { readonly kind: "accepted"; readonly seq: number; readonly requestId: string })
  | (ControlResult & { readonly kind: "rejected"; readonly seq: number; readonly requestId: string; readonly code: RejectionCode; readonly reason: string });

/**
 * Which tier of the attribution spectrum the adapter carries, declared
 * explicitly and required to match what the runtime exposes (adapter red
 * line, docs/spec/runtime-matrix.md): `none`: the runtime has no sub-agents;
 * `opaque`: it has them but its selected interface shows only the root;
 * `attributed`: child records self-attribute via `agentPath`; `nested`:
 * children are sessions of their own, linked in the graph.
 */
export type AttributionTier = "none" | "opaque" | "attributed" | "nested";

export interface SessionCapabilities {
  /** Mid-turn input can be injected into the active turn. */
  readonly steer: boolean;
  /** Input can be held for a LATER turn; `durable` says whether that survives a process restart (codex: runtime-persisted; claude/pi/ACP: this process only). Null when the runtime cannot even hold input. */
  readonly queue: { readonly durable: boolean } | null;
  readonly attribution: AttributionTier;
  /** Input can carry images (`InputOptions.images`), delivered as the runtime's native image content. ACP runtimes: what `initialize` advertised (`promptCapabilities.image`). */
  readonly images: boolean;
}

export type RawEventObserver = (record: RawEvent) => void;
export type EventObserver = (event: Event) => void;
export type Unsubscribe = () => void;

export interface EventsOptions {
  /** Replay retained records after `afterSeq` first, then continue live (same semantics as `rawEvents`). */
  readonly cursor?: Cursor;
  /**
   * Merge consecutive `text_delta` (and readable `reasoning`) events of one
   * agent into one event instead of a token stream. A merged event carries the
   * LAST piece's envelope. It flushes when the kind or agent changes, another
   * event arrives, or (with `maxHoldMs`) the stream goes quiet for that long,
   * so a stalled model pause cannot hold text hostage. Off by default: events
   * are then synchronous and one-to-one with what was read from the stream.
   */
  readonly coalesceText?: boolean | { readonly maxHoldMs: number };
}

/**
 * The SPI face: what an adapter actually builds. The API face extends it
 * with derivations sealSession computes over the stream.
 */
export interface AdapterSession {
  readonly id: string; // runtime-native persistent identity; pass to SessionOptions.resume to reattach later
  readonly capabilities: SessionCapabilities;
  prompt(input: string, options?: InputOptions): Promise<ControlResult>; // ≤1 active turn: rejected `busy` while one runs; NEVER queues implicitly. The request record is the turn's start.
  steer(input: string, options?: InputOptions): Promise<ControlResult>; // mid-turn input; rejected `no_active_turn` when nothing is active, `unsupported` when the runtime cannot inject, `runtime_refused` when the runtime itself refuses (reasons start `not_steerable:`). Input written during runtime-autonomous compaction is HELD, not lost.
  queue(input: string, options?: InputOptions): Promise<ControlResult>; // input for a later turn; rejected when `capabilities.queue` is null. That later turn has events but no request of its own: a spontaneous turn.
  abort(): Promise<ControlResult>; // interrupt the active turn; accepted means the interrupt was delivered, the outcome is the runtime's own turn_ended event. Rejected when nothing is active; a late abort is a normal race, not an error.
  rawEvents(observer: RawEventObserver, cursor?: Cursor): Unsubscribe; // the stream itself, one record at a time. Side-tap: sync, never awaited; a throwing observer must not affect the run or other observers. With a cursor: replays every retained record after `afterSeq` synchronously, then continues live: no loss, no duplication.
  records(): readonly RawEvent[]; // every record this process observed, in seq order
  graph(): SessionGraph;
  dispose(): Promise<void>; // records a dispose request, interrupts active work, releases the runtime, records the exit; idempotent. After an exit the stream already holds (the runtime died on its own), the request is answered `accepted` immediately; nothing is left to release. ALWAYS settles: a runtime process is stopped together with every process it started (its process group, on POSIX), and killed outright when it ignores the stop past a grace period.
}

/** The API face: the SPI plus surfaces sealSession derives from the stream. Control members answer with `ControlOutcome`: the same records, read. */
export interface Session extends AdapterSession {
  prompt(input: string, options?: InputOptions): Promise<ControlOutcome>;
  steer(input: string, options?: InputOptions): Promise<ControlOutcome>;
  queue(input: string, options?: InputOptions): Promise<ControlOutcome>;
  abort(): Promise<ControlOutcome>;
  /**
   * The consumer face of the stream: every fact oar read, flat and attributed
   * (`eventsOf` applied to each record). One frame with three readings is
   * three events sharing a `seq`; a record oar read nothing from yields none.
   * Same side-tap rules as `rawEvents`. This is the surface to start with;
   * reach for `rawEvents` / `records()` when the native frame matters.
   */
  events(observer: EventObserver, options?: EventsOptions): Unsubscribe;
  /** Latest `model` event; null until the runtime has said one. A fold, not an echo of the request. */
  model(): QueryResult<string | null>;
  /** Latest `effort` event: the reasoning-effort level the runtime reports in effect; null until it has said one (claude never does). A fold, not an echo of `SessionOptions.effort`. */
  effort(): QueryResult<string | null>;
  /** THIS session's token total plus a per-agent breakdown when children reported: deduplicated, directly summable (sum = total). A derived child session (own `sessionId`, in `graph()`) is not aggregated here; its usage is in its own records. */
  usage(): QueryResult<SessionUsage>;
  /** Latest context fullness the runtime reported for this session's root agent; null before any. */
  contextUsage(): QueryResult<ContextUsage | null>;
  /**
   * The root agent's status, folded from the stream (`reduceStatus`): idle,
   * or running since the prompt request (or the first event of an adopted
   * turn). Invariant every adapter must keep: a prompt recorded while this
   * says `running` is rejected `busy`, and one recorded while it says `idle`
   * is never rejected `busy`. `awaitIdle` waits on it.
   */
  status(): QueryResult<AgentStatus>;
  /**
   * DERIVED: steer when the runtime can, fall back to queueing, always report
   * where the input landed. `rejected` means the input was NOT taken over and
   * the caller still owns it.
   */
  steerOrQueue(input: string, options?: InputOptions): Promise<SteerOrQueueResult>;
  /**
   * DERIVED: put an input into the session at the moment `when` names
   * (default `now`), choosing prompt, steer or queue from the session's
   * status and retrying across the races between them; an idle session gets
   * a new turn, so an idle agent wakes. For hosts delivering notifications;
   * `origin` tells a UI the input did not come from a person.
   */
  deliver(input: string, options?: DeliverOptions): Promise<DeliverResult>;
}

export interface SessionUsage {
  /** Null until the runtime has reported token totals, never a guessed zero (kimi's ACP surface reports context only). */
  readonly total: TokenTotals | null;
  /** Present only when more than the root agent reported tokens. */
  readonly byAgent?: readonly { readonly agentPath: readonly string[]; readonly tokens: TokenTotals }[];
}

export type SteerOrQueueResult =
  | { readonly landed: "steered"; readonly result: ControlOutcome }
  | { readonly landed: "queued"; readonly result: ControlOutcome }
  /** `result` is the last attempt (the queue when one was made, else the steer); `code` / `reason` are its. */
  | { readonly landed: "rejected"; readonly code: RejectionCode; readonly reason: string; readonly result: ControlOutcome };
