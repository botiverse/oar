/**
 * The record stream: envelope, the three record kinds, event bodies and
 * views, request/response bodies, and the session graph + cursor types.
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

export type RecordKind = "event" | "request" | "response";

/** The runtime's own words. oar never synthesizes an event and never drops one: whatever the runtime said enters the stream, even after a span ended. */
export interface EventRecord extends RecordEnvelope {
  readonly kind: "event";
  readonly body: EventBody;
}

export type RequestDirection = "toRuntime" | "toApp";

/** An action record that expects an outcome. `toRuntime`: prompt / steer / queue / abort / dispose, issued through this Session. `toApp`: the runtime asking the application something (approval, question, external tool), body verbatim. */
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

export type SessionRecord = EventRecord | RequestRecord | ResponseRecord;

/**
 * An event body carries the runtime's frame verbatim plus oar's typed reading
 * of it. `native` is the source of truth; `views` is a projection for
 * consumers that want the cross-runtime vocabulary without parsing five wire
 * formats. One frame is one record: a claude assistant message with a
 * thinking block, a text block and a tool_use block is ONE event with three
 * views, in the frame's own order. A frame oar does not interpret still
 * enters the stream, with `type` and `native` and no views.
 */
export interface EventBody {
  /** Runtime-native discriminator: claude `type[/subtype]`, codex notification method, pi event type, ACP `sessionUpdate`. */
  readonly type: string;
  /** The frame as the runtime sent it (JSON-safe). Never trimmed, never re-shaped. */
  readonly native: unknown;
  /** oar's readings of the frame, in frame order; empty when oar has none. */
  readonly views: readonly EventView[];
}

export type ReasoningContent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "redacted" }
  | { readonly kind: "empty" };

/** Token totals; always cumulative for the agent the record is attributed to. */
export interface TokenTotals {
  readonly input: number;
  readonly output: number;
}

/**
 * What a usage-bearing frame says. `context` is current context fullness as
 * the runtime reports it; `tokens` is the runtime's running total for this
 * record's `agentPath`, already resolved by the adapter (which runtime view is
 * authoritative and how overlapping views deduplicate never crosses this
 * surface; see docs/spec/attribution.md, "usage: one constraint").
 */
export interface UsageReport {
  readonly context?: ContextUsage;
  readonly tokens?: TokenTotals;
}

export type EventView =
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
      /** The runtime's explicit tool outcome; absent when it reported none. */
      readonly result?: "ok" | "failed";
    }
  /** The runtime's OWN completion report for a turn (claude `result`, codex `turn/completed`, pi `agent_end`, an ACP prompt answer). The turn's start is the prompt request record itself; if a runtime reports no end, none appears. */
  | { readonly kind: "turn_ended"; readonly outcome: TurnOutcome }
  | { readonly kind: "usage"; readonly usage: UsageReport }
  /** The model the runtime reports as in effect: its own report, never the request echoed. */
  | { readonly kind: "model"; readonly model: string };

export type RequestBody =
  | { readonly kind: "prompt"; readonly input: string; readonly lineage?: PromptLineage }
  | { readonly kind: "steer"; readonly input: string }
  | { readonly kind: "queue"; readonly input: string }
  | { readonly kind: "abort" }
  | { readonly kind: "dispose" }
  /** A runtime→app request, verbatim; `type` is the runtime's method/subtype. */
  | { readonly kind: "native"; readonly type: string; readonly native: unknown };

/** Host supplied continuity pointer for a new session's first prompt. */
export interface PromptLineage {
  /** Runtime.id of the session being continued. */
  readonly runtime: string;
  readonly sessionId: string;
}

/**
 * Control responses answer only "accepted or not"; final states and landing
 * points are always events. The remaining bodies are outcomes only oar
 * observes: its own answer to a runtime→app request, and the process exit.
 */
export type ResponseBody =
  /** The adapter (or runtime) took the action over. For prompt/steer/queue this is ONE deliberately weak promise: the caller's delivery obligation ENDS; do not resubmit. No guarantee it lands in the current turn, that the model attends to it, or that any business outcome happened; where input landed is the event stream's job. `native` is the runtime's own acknowledgement when it gave one. */
  | { readonly kind: "accepted"; readonly native?: unknown }
  /** Not taken over; the caller still owns the input. `busy` (another turn is active), `not_steerable`, a dead process, or the runtime's typed refusal. */
  | { readonly kind: "rejected"; readonly reason: string; readonly native?: unknown }
  /** oar's reply to a `toApp` request (e.g. the automatic permission grant), verbatim. */
  | { readonly kind: "answered"; readonly native: unknown }
  /** The runtime process exited, an outcome the runtime cannot say itself. Answers a `dispose` request when oar caused it; also recorded for an unrequested exit, pointing at no request. */
  | { readonly kind: "exited"; readonly code: number | null };

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

// ─── Session graph and cursor ─────────────────────────────────────────────

/** True sessions only (docs/spec/session-graph-and-cursor.md): derived child sessions and transcript branches. Agent parent/child is `agentPath`, not a node. */
export interface SessionNode {
  readonly id: string;
}

export interface SessionEdge {
  readonly parent: string;
  readonly child: string;
  readonly via: "tool_call";
}

export interface SessionGraph {
  readonly nodes: readonly SessionNode[];
  readonly edges: readonly SessionEdge[];
}

/** Resume reading after `afterSeq`; `-1` (or omitting the cursor) reads from the start. */
export interface Cursor {
  readonly sessionId: string;
  readonly afterSeq: number;
}
