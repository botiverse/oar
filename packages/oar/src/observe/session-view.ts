import type {
  ContextUsage,
  ControlAction,
  Cursor,
  Event,
  RawEvent,
  ReasoningContent,
  Session,
  SessionUsage,
  SessionGraph,
  TokenTotals,
  ToolOutputPart,
  TurnOutcome,
  Unsubscribe,
} from "../contracts/session.js";
import { withSessionNode } from "./graph.js";
import type { SessionTokens } from "./usage-totals.js";
import { initialStatus, reduceStatus, type AgentStatus } from "./agent-status.js";
import {
  initialConversation,
  reduceConversation,
  type ConversationInput,
  type ConversationState,
} from "./conversation.js";
import { assemble, draftOf, stampTurnOutcome } from "./session-view-fold.js";
import { deferWaitingInputs, foldInputUpdate, turnOpenedBy, upsertInput } from "./session-view-inputs.js";
import { foldEvent, recordFacts } from "./session-view-events.js";
import { upgradeLegacyEvent } from "./legacy.js";

/**
 * The chat-UI projection: grouped messages, agent status, model/usage/context
 * and runtime requests awaiting answers. Pure over the record stream
 * (docs/design/chat-ui.md): replayable from a log, no clock, no IO.
 *
 * Grouping rules, all derived never synthesized:
 * - A TURN is a display segment: it opens on its prompt request or on the
 *   first turn-content event while none is open (adopted: queued input
 *   consumed, mid-turn subscriber, replay slice). A conflicting native start after queue evidence, a dropped input or a rejected prompt
 *   removes its empty provisional turn. Queue evidence alone changes no layout.
 *   `turn_ended` of the ROOT session stamps the open segment; an input
 *   entering mid-turn seals the current segment so seq order stays the
 *   render order, and later content opens a new segment.
 * - An INPUT enters where the runtime took it. A prompt enters at its
 *   request provisionally; native queue evidence arms attribution, and a
 *   conflicting turn moves it to pending until its matching native turn start. A steer or queue enters at its first native
 *   echo (`user_message` with its `inputId`) when the stream echoes input
 *   ids at all, which it shows by having echoed one before (codex, claude);
 *   until then it waits in `pendingInputs`. On a stream that never echoed
 *   one (pi, cursor, ACP runtimes) it enters at its request, the best fact known. A
 *   refused input enters where it was refused; a retry of it that must wait
 *   for its echo takes it back out. A dropped input enters at its discard/exit; a withdrawn input leaves `pendingInputs`
 *   and `messages`; the segment its request sealed stays sealed.
 * - A SECTION groups one lane (`sessionId`, `agentPath`), in first-appearance
 *   order. Named text and readable reasoning rejoin the same kind/messageId
 *   part anywhere in that lane's current segment, never across an input seal.
 *   Tools, notices and unnamed content keep stream order; unnamed messages
 *   can still fragment. Redacted/empty reasoning stay lifecycle-only parts.
 *   A child agent's or session's `turn_ended` is a notice, never a root end.
 * - A TOOL part is one per lane and callId: a progress or end settles it in
 *   the turn its start landed in, even after that turn ended; only a call
 *   whose start was never seen becomes a `?` part. A root turn end or exit
 *   changes its unresolved root tools to `ended`, without a result content
 *   or tool end time. Later native results still replace that unknown result.
 * - A root exit stamps the record-derived status outcome on its open turn:
 *   aborted after an accepted abort or dispose request, failed otherwise.
 *   Flat events lack accepted controls: exit ends tools without a turn outcome.
 */

export type ViewNotice =
  | { readonly cause: "compaction_started"; readonly trigger?: string }
  | {
      readonly cause: "compaction_ended";
      readonly outcome: "completed" | "aborted" | "failed";
      readonly trigger?: string;
      readonly reason?: string;
    }
  | {
      readonly cause: "retry";
      readonly attempt: number;
      readonly maxAttempts?: number;
      readonly delayMs?: number;
      readonly reason?: string;
    }
  | { readonly cause: "control_rejected"; readonly action: ControlAction; readonly reason: string }
  | { readonly cause: "child_turn_ended"; readonly outcome: TurnOutcome }
  | { readonly cause: "exited"; readonly code: number | null };

export type ViewPart =
  /** One assistant message's text; `messageId` when the runtime named the message (`text_delta.messageId`). */
  | { readonly kind: "text"; readonly text: string; readonly messageId?: string }
  | { readonly kind: "reasoning"; readonly content: ReasoningContent; readonly messageId?: string }
  | {
      readonly kind: "tool";
      readonly callId: string;
      readonly tool: string;
      /** The latest input: `tool_call_input_delta` appends raw text; `tool_call_input` replaces it with the complete input. OAR does not parse partial JSON. */
      readonly input?: string;
      /** True after an argument delta, until a complete `tool_call_input` replaces it. An ended call can still have incomplete input. */
      readonly inputPartial?: true;
      /** Current preview: `tool_call_progress.output` replaces it and `outputDelta` appends. Removed when the native result arrives. */
      readonly output?: string;
      /** The result once the call ended (`tool_call_ended.content`). */
      readonly content?: readonly ToolOutputPart[];
      /** `ended` means the call or its root turn ended without a known result. */
      readonly result: "running" | "ok" | "failed" | "ended";
      /**
       * When OAR observed the call start: its `tool_call_started` record's
       * `receivedAt` (epoch ms), not a time the runtime reported. Absent when
       * the start was never seen.
       */
      readonly startedAt?: number;
      /**
       * When OAR observed the call end: its `tool_call_ended` record's
       * `receivedAt` (epoch ms). Absent while it runs, or when the end was
       * never seen. `endedAt - startedAt` is how long it ran, as OAR saw it.
       */
      readonly endedAt?: number;
    }
  | { readonly kind: "notice"; readonly notice: ViewNotice }
  | {
      readonly kind: "app_request";
      readonly requestId: string;
      readonly type: string;
      readonly answered: boolean;
      /** The runtime withdrew the request (`app_request_cancelled`); `answered` stays false. */
      readonly cancelled?: boolean;
      readonly body?: unknown; // the `toApp` body verbatim, as in `pendingRequests`
    };

/** One lane's parts in first-appearance order; named messages can continue in place. */
export interface ViewSection {
  readonly sessionId: string;
  readonly agentPath: readonly string[];
  readonly parts: readonly ViewPart[];
}

export interface ViewTurn {
  readonly kind: "turn";
  readonly id: string;
  /** The prompt request that opened the segment; absent for adopted ones. */
  readonly openedBy?: string;
  readonly sections: readonly ViewSection[];
  /** The native turn end or record-derived exit outcome. Absent on intermediate sealed segments. */
  readonly outcome?: TurnOutcome;
}

export type ViewMessage =
  | { readonly kind: "input"; readonly id: string; readonly input: ConversationInput }
  | ViewTurn
  | { readonly kind: "notice"; readonly id: string; readonly notice: ViewNotice };

/** A runtime→app request nobody has answered and the runtime has not withdrawn. */
export interface PendingRequest {
  readonly requestId: string;
  readonly type: string;
  readonly sessionId: string;
  readonly agentPath: readonly string[];
  readonly seq: number;
  /** The `toApp` request body verbatim; undefined when folded from flat events. */
  readonly body?: unknown;
}

export interface AgentTokens { readonly agentPath: readonly string[]; readonly tokens: TokenTotals }

export interface SessionView {
  readonly messages: readonly ViewMessage[];
  /**
   * Inputs the runtime has not taken yet, in request order. A conflicting turn after `input_queued` defers a prompt until matching `turn_active.inputId`; otherwise steers/queues wait for their first echo on a stream that echoes ids. A host shows them apart.
   * No unrelated turn end or text match places them. A withdrawn input leaves both lists; a dropped input enters messages. Without queue or echo evidence, inputs enter messages at their requests.
   */
  readonly pendingInputs: readonly ConversationInput[];
  /** Index of the unsealed turn segment in `messages`; -1 when none. */
  readonly openTurn: number;
  readonly status: AgentStatus;
  readonly model: string | null;
  /** The latest reasoning-effort level the runtime reported (`effort` events); null before any. */
  readonly effort: string | null;
  /** Latest native service-tier report, null before any. */
  readonly serviceTier: string | null;
  readonly context: ContextUsage | null;
  readonly usage: SessionUsage;
  /** `toApp` requests someone is waited on for: unanswered, not withdrawn by the runtime (`app_request_cancelled`), and emptied when the process exits. */
  readonly pendingRequests: readonly PendingRequest[];
  /** The last observed process exit, when the stream recorded one. */
  readonly exited: { readonly code: number | null } | null;
  /** The fold internals, exposed like `ConversationState`: all derivable. */
  readonly conversation: ConversationState;
  /** sessionId of the latest prompt request: whose `turn_ended` closes turns. */
  readonly rootSessionId: string | undefined;
  /** Replay state for native lineage and every observed session's latest totals; includes children before their lineage arrives. */
  readonly sessionGraph: SessionGraph;
  readonly usageBySession: ReadonlyMap<string, SessionTokens>;
  readonly usageByAgent: ReadonlyMap<string, AgentTokens>;
  /** The runtime's own session total, when it reports one beyond its agents' (`UsageReport.total`); null otherwise. */
  readonly usageTotal: TokenTotals | null;
}

export function initialSessionView(): SessionView {
  return {
    messages: [],
    pendingInputs: [],
    openTurn: -1,
    status: initialStatus,
    model: null,
    effort: null,
    serviceTier: null,
    context: null,
    usage: { total: null },
    pendingRequests: [],
    exited: null,
    conversation: initialConversation(),
    rootSessionId: undefined,
    sessionGraph: { nodes: [], edges: [] },
    usageBySession: new Map(),
    usageByAgent: new Map(), usageTotal: null,
  };
}

/**
 * Fold one record into the view. `streamId` scopes input/request identity the
 * same way it does for `reduceConversation`: one value per native stream,
 * changed across resume so restarted seq domains never collide.
 */
export function reduceSessionView(
  previous: SessionView,
  record: RawEvent,
  streamId = "",
): SessionView {
  if (record.seq <= (previous.conversation.cursors.get(streamId) ?? -1)) {
    // Already folded in this stream (an overlapping history and live push): a no-op.
    return { ...previous, conversation: { ...previous.conversation, updates: [] } };
  }
  const draft = draftOf(previous);
  draft.rootSessionId ??= record.sessionId;
  draft.sessionGraph = withSessionNode(draft.sessionGraph, record.sessionId);
  if (
    record.kind === "request" &&
    record.direction === "toRuntime" &&
    record.body.kind === "prompt"
  ) {
    draft.rootSessionId = record.sessionId;
  }
  const status = reduceStatus(previous.status, record, draft.rootSessionId);
  if (record.kind === "response" && record.body.kind === "exited" && previous.status.kind === "running" && status.kind === "idle" && status.lastTurnOutcome !== undefined) {
    stampTurnOutcome(draft, `turn:${streamId}:${record.sessionId}:${record.seq}`, status.lastTurnOutcome);
  }
  const conversation = reduceConversation(previous.conversation, record, streamId);
  for (const update of conversation.updates) {
    if (update.kind === "input") {
      foldInputUpdate(draft, update.input, conversation);
    } else {
      deferWaitingInputs(draft, update.event, conversation);
      foldEvent(draft, update.event, streamId, turnOpenedBy(update.event, conversation));
    }
  }
  recordFacts(draft, record, streamId);
  return assemble(draft, conversation, status);
}

/**
 * The same fold for pre-flattened `Event`s — `session.events()` subscribers
 * and logs that predate record envelopes. Input facts do not arrive this way;
 * feed them through `reduceSessionViewInput` or use the record path.
 */
export function reduceSessionViewEvent(previous: SessionView, event: Event, streamId = ""): SessionView {
  const draft = draftOf(previous);
  draft.rootSessionId ??= event.sessionId;
  draft.sessionGraph = withSessionNode(draft.sessionGraph, event.sessionId);
  foldEvent(draft, upgradeLegacyEvent(event), streamId);
  return assemble(draft, previous.conversation, previous.status);
}

/** Upsert a user input from a non-record source (an app's own submission log); it enters `messages` now. */
export function reduceSessionViewInput(previous: SessionView, input: ConversationInput): SessionView {
  const draft = draftOf(previous);
  upsertInput(draft, input, false);
  return assemble(draft, previous.conversation, previous.status);
}

/** Replay a whole record log into a view. One `streamId` per call. */
export function viewOf(records: readonly RawEvent[], streamId = ""): SessionView {
  return records.reduce((state, record) => reduceSessionView(state, record, streamId), initialSessionView());
}

/**
 * The composed subscriber: folds the retained prefix, pushes the view on
 * every record after `cursor`. Mirrors `observeConversation`.
 */
export function observeSessionView(session: Session, observer: (view: SessionView) => void, cursor?: Cursor): Unsubscribe {
  let state = initialSessionView();
  return session.rawEvents((record) => {
    state = reduceSessionView(state, record, session.id);
    if (record.seq > (cursor?.afterSeq ?? -1)) {
      observer(state);
    }
  }, { sessionId: session.id, afterSeq: -1 });
}
