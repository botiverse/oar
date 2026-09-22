import type {
  ContextUsage,
  ControlAction,
  Cursor,
  Event,
  RawEvent,
  ReasoningContent,
  Session,
  SessionUsage,
  TokenTotals,
  TurnOutcome,
  Unsubscribe,
} from "../contracts/session.js";
import { initialStatus, reduceStatus, type AgentStatus } from "./agent-status.js";
import {
  initialConversation,
  reduceConversation,
  type ConversationInput,
  type ConversationState,
} from "./conversation.js";
import { assemble, draftOf, upsertInput } from "./session-view-fold.js";
import { foldEvent, recordFacts } from "./session-view-events.js";

/**
 * The chat-UI projection: one `SessionView` is everything a conversation
 * surface needs — grouped messages, agent status, model/usage/context, and
 * the runtime requests still awaiting an answer. Pure over the record
 * stream (docs/design/chat-ui.md): replayable from a log, no clock, no IO.
 *
 * Grouping rules, all derived never synthesized:
 * - A TURN is a display segment: it opens on its prompt request or on the
 *   first turn-content event while none is open (adopted: queued input
 *   consumed, mid-turn subscriber, replay slice). A rejected prompt removes
 *   its empty turn — the turn never began (same rule as `reduceStatus`).
 *   `turn_ended` of the ROOT session stamps the open segment; an input
 *   arriving mid-turn seals the current segment so seq order stays the
 *   render order, and later content opens a new segment.
 * - A SECTION is a contiguous run of one lane (`sessionId`, `agentPath`)
 *   inside a turn. Sub-agent and child-session activity nests inside the
 *   parent turn as sections; a child session's own `turn_ended` degrades
 *   to a notice part, it never closes the root turn.
 * - An exited stream never stamps a fabricated outcome on an open turn.
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
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "reasoning"; readonly content: ReasoningContent }
  | {
      readonly kind: "tool";
      readonly callId: string;
      readonly tool: string;
      readonly input?: string;
      readonly output?: string;
      readonly result: "running" | "ok" | "failed" | "ended";
    }
  | { readonly kind: "notice"; readonly notice: ViewNotice }
  | {
      readonly kind: "app_request";
      readonly requestId: string;
      readonly type: string;
      readonly answered: boolean;
      readonly body?: unknown;
    };

/** One contiguous lane run inside a turn. */
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
  /** The runtime's own turn end. Absent on sealed segments and interrupted turns. */
  readonly outcome?: TurnOutcome;
}

export type ViewMessage =
  | { readonly kind: "input"; readonly id: string; readonly input: ConversationInput }
  | ViewTurn
  | { readonly kind: "notice"; readonly id: string; readonly notice: ViewNotice };

/** A runtime→app request still awaiting an answer (or the record of one). */
export interface PendingRequest {
  readonly requestId: string;
  readonly type: string;
  readonly sessionId: string;
  readonly agentPath: readonly string[];
  readonly seq: number;
  /** The `toApp` request body verbatim; undefined when folded from flat events. */
  readonly body?: unknown;
}

export interface AgentTokens {
  readonly agentPath: readonly string[];
  readonly tokens: TokenTotals;
}

export interface SessionView {
  readonly messages: readonly ViewMessage[];
  /** Index of the unsealed turn segment in `messages`; -1 when none. */
  readonly openTurn: number;
  readonly status: AgentStatus;
  readonly model: string | null;
  readonly context: ContextUsage | null;
  readonly usage: SessionUsage;
  readonly pendingRequests: readonly PendingRequest[];
  /** The last observed process exit, when the stream recorded one. */
  readonly exited: { readonly code: number | null } | null;
  /** The fold internals, exposed like `ConversationState`: all derivable. */
  readonly conversation: ConversationState;
  /** sessionId of the latest prompt request: whose `turn_ended` closes turns. */
  readonly rootSessionId: string | undefined;
  readonly usageByAgent: ReadonlyMap<string, AgentTokens>;
}

export function initialSessionView(): SessionView {
  return {
    messages: [],
    openTurn: -1,
    status: initialStatus,
    model: null,
    context: null,
    usage: { total: null },
    pendingRequests: [],
    exited: null,
    conversation: initialConversation(),
    rootSessionId: undefined,
    usageByAgent: new Map(),
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
  const draft = draftOf(previous);
  draft.rootSessionId ??= record.sessionId;
  if (
    record.kind === "request" &&
    record.direction === "toRuntime" &&
    record.body.kind === "prompt"
  ) {
    draft.rootSessionId = record.sessionId;
  }
  const status = reduceStatus(previous.status, record, draft.rootSessionId);
  const conversation = reduceConversation(previous.conversation, record, streamId);
  for (const update of conversation.updates) {
    if (update.kind === "input") {
      upsertInput(draft, update.input);
    } else {
      foldEvent(draft, update.event, streamId);
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
export function reduceSessionViewEvent(
  previous: SessionView,
  event: Event,
  streamId = "",
): SessionView {
  const draft = draftOf(previous);
  draft.rootSessionId ??= event.sessionId;
  foldEvent(draft, event, streamId);
  return assemble(draft, previous.conversation, previous.status);
}

/** Upsert a user input from a non-record source (an app's own submission log). */
export function reduceSessionViewInput(
  previous: SessionView,
  input: ConversationInput,
): SessionView {
  const draft = draftOf(previous);
  upsertInput(draft, input);
  return assemble(draft, previous.conversation, previous.status);
}

/** Replay a whole record log into a view. One `streamId` per call. */
export function viewOf(records: readonly RawEvent[], streamId = ""): SessionView {
  return records.reduce(
    (state, record) => reduceSessionView(state, record, streamId),
    initialSessionView(),
  );
}

/**
 * The composed subscriber: folds the retained prefix, pushes the view on
 * every record after `cursor`. Mirrors `observeConversation`.
 */
export function observeSessionView(
  session: Session,
  observer: (view: SessionView) => void,
  cursor?: Cursor,
): Unsubscribe {
  let state = initialSessionView();
  return session.rawEvents((record) => {
    state = reduceSessionView(state, record, session.id);
    if (record.seq > (cursor?.afterSeq ?? -1)) {
      observer(state);
    }
  }, { sessionId: session.id, afterSeq: -1 });
}
