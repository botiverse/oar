import type { CredentialProblem, FailureClass } from "./failure.js";
import type { InputImage, InputOrigin } from "./input.js";
import type { TaskEventBody } from "./tasks.js";
import type { ToolOutputPart } from "./tool-output.js";

/**
 * The record stream and the events read off it. Three words, three layers:
 *
 * - `Event`: the consumer face. One flat, attributed fact (text, a tool
 *   call, a turn end, a process exit …). What `Session.events()` delivers.
 * - `RawEvent`: one record of the underlying stream, three kinds by
 *   obligation: `Frame` (the runtime's own words), `RequestRecord` (an
 *   action expecting an outcome), `ResponseRecord` (points at a request).
 *   What `Session.rawEvents()` / `records()` deliver.
 * - `Frame`: a RawEvent carrying one runtime frame verbatim (`type`,
 *   `native`) plus the events oar read out of it.
 *
 * Semantics live in docs/spec; the session control surface that produces
 * these records is in ./session.ts.
 */

// ─── The record stream ────────────────────────────────────────────────────

/**
 * Self-certifying envelope on every record (docs/spec/attribution.md).
 * Identity and ordering rest on `seq` alone; `receivedAt` is best-effort
 * observation time outside any determinism guarantee.
 */
export interface RecordEnvelope {
  /** Runtime-native session the record belongs to. A derived child session (grok child session, codex child thread) carries ITS OWN id here; the session graph says where it came from, and the Session folds (model/usage/contextUsage, awaitTurnEnd) scope to the root session. */
  readonly sessionId: string;
  /** Sub-agent lineage inside the session; `[]` is the root agent. Identity of a tool call or span is the composite `(agentPath, id)`; a bare callId is never a global key. */
  readonly agentPath: readonly string[];
  /** Runtime-native turn/span id when the runtime has one (codex turnId). oar never generates it; absent means the runtime reported none. */
  readonly spanId?: string;
  /** Monotonic per stream; the cursor anchor and the total order for trace alignment. */
  readonly seq: number;
  /** Unix epoch milliseconds stamped at adapter ingress: same clock as Date.now(), so fold×clock consumers (stallOf) compose directly. */
  readonly receivedAt: number;
}

export type RecordKind = "frame" | "request" | "response";

/** The runtime's own words. oar never synthesizes a frame and never drops one: whatever the runtime said enters the stream, even after a span ended. */
export interface Frame extends RecordEnvelope {
  readonly kind: "frame";
  readonly body: FrameBody;
}

export type RequestDirection = "toRuntime" | "toApp";

/** An action record that expects an outcome. `toRuntime`: prompt / steer / queue / withdraw / abort / dispose, issued through this Session. `toApp`: the runtime asking the application something (approval, question, external tool), body verbatim. */
export interface RequestRecord extends RecordEnvelope {
  readonly kind: "request";
  readonly id: string;
  readonly direction: RequestDirection;
  readonly body: RequestBody;
}

/** Always points at a request; the reverse is not guaranteed. A request without a response is an honest record: the action was initiated and its outcome was not observed. Backfilling a guessed response is forbidden. */
export interface ResponseRecord extends RecordEnvelope {
  readonly kind: "response";
  readonly requestId: string;
  readonly body: ResponseBody;
}

/** One record of the stream. */
export type RawEvent = Frame | RequestRecord | ResponseRecord;

/**
 * A frame body carries the runtime's frame, except documented credential-field
 * redaction, plus oar's typed reading. `native` is the source of truth; `events` is a projection for
 * consumers that want the cross-runtime vocabulary without parsing five wire
 * formats. One frame is one record: a claude assistant message with a
 * thinking block, a text block and a tool_use block is ONE frame with three
 * events, in the frame's own order. A frame oar does not interpret still
 * enters the stream, with `type` and `native` and no events.
 */
export interface FrameBody {
  /** Runtime-native discriminator: claude `type[/subtype]`, codex notification method, pi event type, ACP `sessionUpdate`. */
  readonly type: string;
  /** The frame as sent (JSON-safe), except documented credential-field redaction. Never otherwise trimmed or re-shaped. */
  readonly native: unknown;
  /** What oar read out of the frame, in frame order; empty when oar read nothing. Only runtime-said kinds appear here. */
  readonly events: readonly RuntimeEventBody[];
}

export type ReasoningContent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "redacted" }
  | { readonly kind: "empty" };

/**
 * Token totals for the agent the record is attributed to, counted from when this Session opened.
 * `cacheRead` / `cacheWrite` are parts of `input`, accumulated like it and
 * each present only when the runtime reports it: a reported 0 is 0, an
 * unreported part is absent (never derived), a report without a part adds
 * nothing to it, and a part once present stays (docs/spec/attribution.md).
 */
export interface TokenTotals {
  /** All input, cache reads and writes included. */
  readonly input: number;
  readonly output: number;
  /** The part of `input` read from the prompt cache. */
  readonly cacheRead?: number;
  /** The part of `input` written to the prompt cache. */
  readonly cacheWrite?: number;
}

/**
 * What a usage-bearing frame says. `context` is current context fullness as
 * the runtime reports it; `tokens` is the running total for this record's
 * `agentPath` counted from when this Session opened, resolved by the adapter
 * (the authoritative figure, deduplication and what a resumed runtime had
 * already counted never cross this surface; docs/spec/attribution.md).
 */
export interface UsageReport {
  readonly context?: ContextUsage;
  readonly tokens?: TokenTotals;
}

/** A native user-message observation, not proof of model consumption. */
export interface UserMessage {
  readonly kind: "user_message";
  readonly input: string;
  readonly inputId?: string;
  readonly nativeMessageId?: string;
  readonly turnId?: string;
  readonly evidence: "acknowledged" | "turn_item" | "conversation";
}

/**
 * The runtime-said event kinds: what a Frame can carry. `text_delta` is at
 * the granularity the runtime emits (claude, pi and codex: streamed pieces); `Session.events({ coalesceText })`
 * merges consecutive pieces for consumers who want blocks.
 */
export type RuntimeEventBody = UserMessage
  /** The runtime discarded an input on interruption, established by its native marker or documented behavior. Returns ownership to the caller for resend; never inferred by a view from turn completion. */
  | { readonly kind: "input_dropped"; readonly inputId: string; readonly reason: "turn_interrupted" }
  /** `messageId`: the runtime's id of the assistant message the text is part of (codex `agentMessage` item, claude API message), so two messages of one turn stay apart; absent when it names none (pi, cursor, ACP) and in older records. */
  | { readonly kind: "text_delta"; readonly text: string; readonly messageId?: string }
  /** A reasoning output item; its lifecycle remains observable without readable contents. `messageId` names the native message when provided, keeping streamed reasoning from distinct messages apart when coalescing. */
  | { readonly kind: "reasoning"; readonly content: ReasoningContent; readonly messageId?: string }
  | {
      readonly kind: "tool_call_started";
      readonly callId: string;
      readonly tool: string;
      /** Best-effort human-readable invocation detail when the runtime exposes it. */
      readonly input?: string;
    }
  /** Arguments the runtime reported after the call started (an ACP `tool_call_update` carrying a `rawInput` that differs from the last one read for the call). The WHOLE input in `tool_call_started.input`'s form, replacing it and any earlier `tool_call_input` of the call, never a delta; the started record stays as the runtime first said it. */
  | { readonly kind: "tool_call_input"; readonly callId: string; readonly input: string }
  | {
      readonly kind: "tool_call_ended";
      readonly callId: string;
      /** The result as the runtime reported it, in its order: text parts, images (base64 with their media type, normalized from the runtime's own block shape), and blocks OAR does not recognize kept whole as `other`. Absent when the runtime reported no result. The native frame keeps the original. */
      readonly content?: readonly ToolOutputPart[];
      /** The runtime's explicit tool outcome; absent when it reported none. */
      readonly result?: "ok" | "failed";
      /** The process exit status the runtime reported for a command it ran (codex `commandExecution.exitCode`, grok and antigravity `rawOutput.exit_code`, a cursor shell result's `exitCode`); `null` when the runtime says it ended without one (a signal). Absent when the runtime reports none (claude, pi), never derived from `result` or output. */
      readonly exitCode?: number | null;
    }
  /** Partial output of a running tool call, when the runtime streams it (pi `tool_execution_update`, codex `item/commandExecution/outputDelta`, an ACP `tool_call_update` carrying `rawOutput`). claude streams none; cursor's shell output deltas are recorded with no event. */
  | { readonly kind: "tool_call_progress"; readonly callId: string; readonly output?: string }
  /** The runtime's OWN completion report for a turn (claude `result`, codex `turn/completed`, pi `agent_end`, an ACP prompt answer). The turn's start is the prompt request record itself; if a runtime reports no end, none appears. */
  | { readonly kind: "turn_ended"; readonly outcome: TurnOutcome }
  /** The runtime began compacting its context. `trigger` is the runtime's own word for why (pi: manual | threshold | overflow; codex: none). claude reports only the boundary after the fact, so it never says this. */
  | { readonly kind: "compaction_started"; readonly trigger?: string }
  /**
   * The runtime finished (or gave up) compacting (pi `compaction_end`, claude
   * `system/compact_boundary`, codex `contextCompaction` item completed).
   * `trigger` as above (claude: manual | auto); `reason` is the runtime's
   * error text when it failed. ACP runtimes report no compaction.
   */
  | { readonly kind: "compaction_ended"; readonly outcome: "completed" | "aborted" | "failed"; readonly trigger?: string; readonly reason?: string }
  /** The runtime announced it will retry a failed provider call (pi `auto_retry_start`, `summarization_retry_scheduled`). Other shipped runtimes retry silently or not at all. */
  | { readonly kind: "retry"; readonly attempt: number; readonly maxAttempts?: number; readonly delayMs?: number; readonly reason?: string }
  | { readonly kind: "usage"; readonly usage: UsageReport }
  /** The model the runtime reports as in effect: its own report, never the request echoed. */
  | { readonly kind: "model"; readonly model: string }
  | TaskEventBody
  /** The reasoning-effort level the runtime reports as in effect, in its own spelling (codex `reasoningEffort`, an ACP `thought_level` option's current value, pi `thinkingLevel`, cursor's reasoning parameter): its own report, never the request echoed. claude's stream carries none. */
  | { readonly kind: "effort"; readonly effort: string };

/** The toRuntime control actions a Session issues. */
export type ControlAction = "prompt" | "steer" | "queue" | "withdraw" | "abort" | "dispose";

/**
 * Event kinds read off request and response records, so a consumer of
 * `Session.events()` sees the control facts that matter without handling
 * record kinds: a turn's start (the prompt request), a held input taken back
 * (an accepted withdraw), a control action the runtime or adapter refused, a
 * runtime→app request and oar's answer to it, and the process exit. Never
 * carried by a Frame.
 */
export type ControlEventBody =
  /** A prompt request was recorded: the turn's start. `requestId` pairs it with a later `control_rejected` when the prompt did not begin a turn. */
  | { readonly kind: "turn_started"; readonly requestId: string; readonly input: string }
  /** A withdraw was accepted: the held input `inputId` was removed before it was sent, and the caller owns it again. The queue request that held it stays in the stream unchanged. */
  | { readonly kind: "input_withdrawn"; readonly requestId: string; readonly inputId: string }
  /** A `toRuntime` control action was rejected; the caller still owns the input. */
  | { readonly kind: "control_rejected"; readonly requestId: string; readonly action: ControlAction; readonly code: RejectionCode; readonly reason: string }
  /** The runtime asked the application something (a `toApp` request: approval, question, terminal). `type` is the runtime's method or subtype; the body is on the request record. */
  | { readonly kind: "app_request"; readonly requestId: string; readonly type: string }
  /** oar answered a `toApp` request automatically (an `answered` response). */
  | { readonly kind: "app_answered"; readonly requestId: string }
  /** The runtime process exited (an `exited` response). */
  | { readonly kind: "exited"; readonly code: number | null };

/** Every event kind `Session.events()` can deliver. */
export type EventBody = RuntimeEventBody | ControlEventBody;

/**
 * The consumer face of the stream: one attributed fact. An Event is an
 * EventBody plus the envelope of the record it was read from, so it carries
 * `seq` (several events read from one frame share it), `agentPath`,
 * `spanId` and `receivedAt` without the consumer touching the record. Lossy
 * by design (no `native`, no `type`), and always re-derivable from the
 * RawEvent stream via `eventsOf`.
 */
export type Event = EventBody & RecordEnvelope;

export type RequestBody =
  | { readonly kind: "prompt"; readonly inputId?: string; readonly input: string; readonly images?: readonly InputImage[]; readonly origin?: InputOrigin }
  | { readonly kind: "steer"; readonly inputId?: string; readonly input: string; readonly images?: readonly InputImage[]; readonly origin?: InputOrigin }
  | { readonly kind: "queue"; readonly inputId?: string; readonly input: string; readonly images?: readonly InputImage[]; readonly origin?: InputOrigin }
  /** Take back the held input `inputId` (an earlier queue request's) before it is sent. The queue request and its response are never changed. */
  | { readonly kind: "withdraw"; readonly inputId: string }
  | { readonly kind: "abort" }
  | { readonly kind: "dispose" }
  /** A runtime→app request, verbatim; `type` is the runtime's method/subtype. */
  | { readonly kind: "native"; readonly type: string; readonly native: unknown };

/**
 * Why a control action was not taken over, as one word an application can
 * branch on without parsing prose. `reason` on the same body keeps the prose
 * (the runtime's own message when it gave one). Every adapter answers the
 * same situation with the same code: `busy` iff `Session.status()` was
 * running when the prompt was recorded.
 */
export type RejectionCode =
  /** prompt: another turn is active (≤1 active turn; nothing is queued implicitly). */
  | "busy"
  /** steer / abort: nothing is running; a late abort is a normal race, not an error. */
  | "no_active_turn"
  /** withdraw: no held input with this `inputId` is waiting: it was already sent to the runtime, never queued in this session, or already withdrawn. Never answered `accepted` when the input may already have gone. */
  | "not_queued"
  /** The runtime cannot do this control with these inputs: images where it takes none, or a format it does not read, images on a cursor steer, or empty text with no images. A control the runtime cannot do at all is an absent member (`Session.steer`), not a rejection. */
  | "unsupported"
  /** The stream already holds the process exit. */
  | "runtime_exited"
  /** The stream already holds this session's dispose request. */
  | "disposed"
  /** The runtime answered no (its typed refusal, an RPC error); `reason` is its message. */
  | "runtime_refused"
  /** The adapter could not deliver (a thrown transport error); `reason` is the exception message. */
  | "error";

/**
 * Control responses answer only "accepted or not"; final states and landing
 * points are always events. The remaining bodies are outcomes only oar
 * observes: its own answer to a runtime→app request, and the process exit.
 */
export type ResponseBody =
  /** The adapter (or runtime) took the action over. For prompt/steer/queue this is ONE deliberately weak promise: the caller's delivery obligation ENDS; do not resubmit. No guarantee it lands in the current turn, that the model attends to it, or that any business outcome happened; where input landed is the event stream's job. For withdraw it is a strong one: the held input was removed before it was sent, and the caller owns it again. `native` is the runtime's own acknowledgement when it gave one. */
  | { readonly kind: "accepted"; readonly native?: unknown }
  /** Not taken over; the caller still owns the input. `code` says why in one word; `reason` is the prose. */
  | { readonly kind: "rejected"; readonly code: RejectionCode; readonly reason: string; readonly native?: unknown }
  /** oar's reply to a `toApp` request (e.g. the automatic permission grant), verbatim. */
  | { readonly kind: "answered"; readonly native: unknown }
  /** The runtime process exited, an outcome the runtime cannot say itself. Answers a `dispose` request when oar caused it; also recorded for an unrequested exit, pointing at no request. */
  | { readonly kind: "exited"; readonly code: number | null };

export type TurnOutcome =
  | { readonly kind: "completed" }
  | { readonly kind: "aborted" }
  | {
    readonly kind: "failed";
    readonly reason: string;
    readonly failure: FailureClass;
    /** With `auth`, where the runtime says which. */
    readonly credential?: CredentialProblem;
    /** The provider's HTTP status, where the runtime reports one. */
    readonly status?: number;
  };

/**
 * Current context fullness, borrowed from pi's shape because it already
 * models the hard case: `tokens` is null when unknown (right after compaction,
 * before the next model response), and `percent` follows.
 */
export interface ContextUsage {
  readonly tokens: number | null;
  readonly contextWindow: number | null;
  readonly percent: number | null;
}

// ─── Session graph and cursor: ./graph.ts ─────────────────────────────────

export type { Cursor, SessionEdge, SessionGraph, SessionNode } from "./graph.js";
