import type {
  ContextUsage,
  Cursor,
  RequestRecord,
  ResponseRecord,
  SessionGraph,
  SessionRecord,
  TokenTotals,
} from "./records.js";
import type { AvailableInstallation } from "./installation.js";

export type {
  ContextUsage,
  Cursor,
  EventBody,
  EventRecord,
  EventView,
  FailureClass,
  ReasoningContent,
  RecordEnvelope,
  RecordKind,
  RequestBody,
  RequestDirection,
  RequestRecord,
  ResponseBody,
  ResponseRecord,
  SessionEdge,
  SessionGraph,
  SessionNode,
  SessionRecord,
  TokenTotals,
  TurnOutcome,
  UsageReport,
} from "./records.js";

/**
 * Session contract: one ordered, resumable record stream.
 *
 * The external promise (docs/spec): everything the runtime said is in the
 * stream, nothing oar didn't observe is in it, every record knows whose it
 * is, and the stream is readable again from any position. Records split by
 * OBLIGATION into three kinds — event (the runtime's own words), request (an
 * action that expects an outcome) and response (points at a request) — and
 * travel on one channel with one monotonic `seq`. Behavior invariants live as
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
 *   sits at an approval prompt — a gate is a hang, not safety. A host wanting
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

// ─── Control surface ──────────────────────────────────────────────────────

/** Both records a control call produced: the request (its `seq` is where the action sits in the stream) and the accept/reject response. */
export interface ControlResult {
  readonly request: RequestRecord;
  readonly response: ResponseRecord;
}

/**
 * Which tier of the attribution spectrum the adapter carries, declared
 * explicitly and required to match what the runtime exposes (adapter red
 * line, docs/spec/runtime-matrix.md): `none` — the runtime has no sub-agents;
 * `opaque` — it has them but its selected interface shows only the root;
 * `attributed` — child records self-attribute via `agentPath`; `nested` —
 * children are sessions of their own, linked in the graph.
 */
export type AttributionTier = "none" | "opaque" | "attributed" | "nested";

export interface SessionCapabilities {
  /** Mid-turn input can be injected into the active turn. */
  readonly steer: boolean;
  /** Input can be held for a LATER turn; `durable` says whether that survives a process restart (codex: runtime-persisted; claude/pi/ACP: this process only). Null when the runtime cannot even hold input. */
  readonly queue: { readonly durable: boolean } | null;
  readonly attribution: AttributionTier;
}

export type SessionObserver = (record: SessionRecord) => void;
export type Unsubscribe = () => void;

/**
 * The SPI face: what an adapter actually builds. The API face extends it
 * with derivations sealSession computes over the stream.
 */
export interface AdapterSession {
  readonly id: string; // runtime-native persistent identity — pass to SessionOptions.resume to reattach later
  readonly capabilities: SessionCapabilities;
  prompt(input: string): Promise<ControlResult>; // ≤1 active turn: rejected `busy` while one runs; NEVER queues implicitly. The request record is the turn's start.
  steer(input: string): Promise<ControlResult>; // mid-turn input; rejected `not_steerable` when nothing is active or the runtime cannot inject. Input written during runtime-autonomous compaction is HELD, not lost.
  queue(input: string): Promise<ControlResult>; // input for a later turn; rejected when `capabilities.queue` is null. That later turn has events but no request of its own — a spontaneous turn.
  abort(): Promise<ControlResult>; // interrupt the active turn; accepted means the interrupt was delivered, the outcome is the runtime's own turn_ended event. Rejected when nothing is active — a late abort is a normal race, not an error.
  subscribe(observer: SessionObserver, cursor?: Cursor): Unsubscribe; // side-tap: sync, never awaited; a throwing observer must not affect the run or other observers. With a cursor: replays every retained record after `afterSeq` synchronously, then continues live — no loss, no duplication.
  records(): readonly SessionRecord[]; // every record this process observed, in seq order
  graph(): SessionGraph;
  dispose(): Promise<void>; // records a dispose request, interrupts active work, releases the runtime, records the exit; idempotent
}

/** The API face: the SPI plus surfaces sealSession derives from the stream. */
export interface Session extends AdapterSession {
  /** Latest `model` event; null until the runtime has said one. A fold, not an echo of the request. */
  model(): string | null;
  /** Session token total plus a per-agent breakdown when children reported: deduplicated, directly summable (sum = total). */
  usage(): SessionUsage;
  /** Latest context fullness the runtime reported for the root agent; null before any. */
  contextUsage(): ContextUsage | null;
  /**
   * DERIVED: steer when the runtime can, fall back to queueing, always report
   * where the input landed. `rejected` means the input was NOT taken over and
   * the caller still owns it.
   */
  steerOrQueue(input: string): Promise<SteerOrQueueResult>;
}

export interface SessionUsage {
  readonly total: TokenTotals;
  /** Present only when more than the root agent reported tokens. */
  readonly byAgent?: readonly { readonly agentPath: readonly string[]; readonly tokens: TokenTotals }[];
}

export type SteerOrQueueResult =
  | { readonly landed: "steered"; readonly result: ControlResult }
  | { readonly landed: "queued"; readonly result: ControlResult }
  | { readonly landed: "rejected"; readonly reason: string; readonly result: ControlResult };
