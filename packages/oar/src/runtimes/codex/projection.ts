import type {
  EventBody,
  EventView,
  SessionEdge,
  TurnOutcome,
} from "../../contracts/session.js";
import { classifyFailure } from "../../shared/failure-class.js";
import { asNumber, asRecord, type JsonRecord } from "../../shared/json.js";
import { codexItemInput, codexItemOutput } from "./item-detail.js";
import { codexReasoningContent } from "./reasoning.js";

/**
 * The codex notification → record projection as a PURE FOLD (see
 * runtimes/claude/projection.ts for the shape). Every notification becomes
 * exactly one event command: verbatim `native`, views in oar's vocabulary,
 * the runtime's own turn id as `spanId`. Plus, for collaboration items that
 * name other threads, a link command for the session graph. Nothing is gated
 * on turn state and nothing is dropped; the adapter applies the commands and
 * separately owns the transport-only turn id (steer/abort identity), which is
 * not part of the projection. Behavior is pinned by tests/replay against
 * recorded fixtures.
 */

const TOOL_ITEM_TYPES = new Set(["commandExecution", "fileChange", "mcpToolCall", "webSearch"]);
const COLLAB_ITEM_TYPES = new Set(["collabAgentToolCall", "collabToolCall", "subAgentActivity"]);

export type ProjectionCommand =
  | {
      readonly kind: "event";
      readonly body: EventBody;
      /** Runtime-native turn id when the notification carries one. */
      readonly spanId?: string;
      /** Set when the notification belongs to another thread: a derived child session. */
      readonly sessionId?: string;
    }
  | { readonly kind: "link"; readonly edge: SessionEdge };

/**
 * `lastErrorDetail` carries codex's structured `error` notification (which its
 * terminal turn status does NOT include) into the failed turn_ended reason.
 */
export interface CodexProjectionState {
  readonly rootThreadId: string;
  readonly lastErrorDetail: string | null;
}

export function initialCodexProjection(rootThreadId: string): CodexProjectionState {
  return { rootThreadId, lastErrorDetail: null };
}

// The runtime's own status is the truth: an interrupt that landed reports
// "interrupted"; one that lost the race to completion reports "completed".
function outcomeFromStatus(status: unknown): TurnOutcome {
  switch (status) {
    case "interrupted":
      return { kind: "aborted" };
    case "completed":
      return { kind: "completed" };
    default: {
      const reason = typeof status === "string" ? status : "unknown";
      return { kind: "failed", reason, failure: classifyFailure(reason) };
    }
  }
}

function toolViews(method: string, item: JsonRecord | null): EventView[] {
  const itemType = typeof item?.type === "string" ? item.type : "";
  if (!TOOL_ITEM_TYPES.has(itemType)) {
    return [];
  }
  const itemId = typeof item?.id === "string" ? item.id : "unknown";
  if (method === "item/started") {
    const input = item === null ? undefined : codexItemInput(item);
    return [input === undefined
      ? { kind: "tool_call_started", callId: itemId, tool: itemType }
      : { kind: "tool_call_started", callId: itemId, tool: itemType, input }];
  }
  const output = item === null ? undefined : codexItemOutput(item);
  return [output === undefined
    ? { kind: "tool_call_ended", callId: itemId }
    : { kind: "tool_call_ended", callId: itemId, output }];
}

function settleOutcome(state: CodexProjectionState, status: unknown): TurnOutcome {
  const outcome = outcomeFromStatus(status);
  if (outcome.kind === "failed" && state.lastErrorDetail !== null) {
    const reason = `${outcome.reason}: ${state.lastErrorDetail}`;
    return { kind: "failed", reason, failure: classifyFailure(reason) };
  }
  return outcome;
}

/**
 * `tokenUsage.total` accumulates over every model call of the thread's life
 * (input 12.6k → 28.4k → 44.2k across three one-word turns, codex 0.154.0),
 * so it is the running spend, not what the context holds. `tokenUsage.last`
 * is the most recent model call, and `modelContextWindow` the window it fit
 * in; those two are the context reading. Codex's own occupancy figure is
 * `last.total_tokens` (`TokenUsage::tokens_in_context_window`, protocol.rs
 * at 4f39251a; the TUI's status card reads it off `last_token_usage`; its
 * percent also subtracts a 12k baseline). oar reads the same field,
 * `last.totalTokens`: the last call's input (cached tokens included) plus its
 * output, which is what the context holds once the reply is in, matching
 * the runtime's own reading rather than undercounting by the last output.
 * When `last` is absent (older builds) the occupancy is unknown: the
 * cumulative input stands in as `tokens` and the window and percent are
 * null: the cumulative total is never read against the window.
 */
function usageViews(params: JsonRecord): EventView[] {
  const tokenUsage = asRecord(params.tokenUsage);
  const total = asRecord(tokenUsage?.total);
  if (total === null) {
    return [];
  }
  const input = asNumber(total.inputTokens);
  const output = asNumber(total.outputTokens);
  const tokens = input === null || output === null ? {} : { tokens: { input, output } };
  const last = asRecord(tokenUsage?.last);
  if (last === null) {
    return [{ kind: "usage", usage: { context: { tokens: input, contextWindow: null, percent: null }, ...tokens } }];
  }
  const contextTokens = asNumber(last.totalTokens);
  const contextWindow = asNumber(tokenUsage?.modelContextWindow);
  const percent = contextTokens === null || contextWindow === null || contextWindow <= 0
    ? null
    : Math.round((contextTokens / contextWindow) * 100);
  return [{ kind: "usage", usage: { context: { tokens: contextTokens, contextWindow, percent }, ...tokens } }];
}

/** Edges a collaboration item establishes: the root (sender) thread spawned or addressed the named threads. */
function collabEdges(state: CodexProjectionState, item: JsonRecord | null): SessionEdge[] {
  if (item === null || typeof item.type !== "string" || !COLLAB_ITEM_TYPES.has(item.type)) {
    return [];
  }
  const parent = typeof item.senderThreadId === "string" ? item.senderThreadId : state.rootThreadId;
  const receivers: unknown[] = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [];
  const children = [...receivers, item.agentThreadId]
    .filter((id): id is string => typeof id === "string" && id.length > 0 && id !== parent);
  return children.map((child) => ({ parent, child, via: "tool_call" as const }));
}

function spanIdOf(params: JsonRecord): string | undefined {
  if (typeof params.turnId === "string") {
    return params.turnId;
  }
  const turnId = asRecord(params.turn)?.id;
  return typeof turnId === "string" ? turnId : undefined;
}

function viewsFor(state: CodexProjectionState, method: string, params: JsonRecord): EventView[] {
  switch (method) {
    case "item/agentMessage/delta":
      return typeof params.delta === "string" ? [{ kind: "text_delta", text: params.delta }] : [];
    case "rawResponseItem/completed": {
      const content = codexReasoningContent(asRecord(params.item));
      return content === null ? [] : [{ kind: "reasoning", content }];
    }
    case "item/started":
    case "item/completed":
      return toolViews(method, asRecord(params.item));
    case "turn/completed":
      return [{ kind: "turn_ended", outcome: settleOutcome(state, asRecord(params.turn)?.status) }];
    case "thread/tokenUsage/updated":
      return usageViews(params);
    default:
      return [];
  }
}

/** Fold one codex notification into the next state plus commands. */
export function foldCodexNotification(
  state: CodexProjectionState,
  method: string,
  params: JsonRecord,
): { readonly state: CodexProjectionState; readonly commands: readonly ProjectionCommand[] } {
  const threadId = typeof params.threadId === "string" ? params.threadId : state.rootThreadId;
  const spanId = spanIdOf(params);
  const event: ProjectionCommand = {
    kind: "event",
    body: { type: method, native: params, views: viewsFor(state, method, params) },
    ...(spanId === undefined ? {} : { spanId }),
    ...(threadId === state.rootThreadId ? {} : { sessionId: threadId }),
  };
  const links = method === "item/started" || method === "item/completed"
    ? collabEdges(state, asRecord(params.item)).map((edge): ProjectionCommand => ({ kind: "link", edge }))
    : [];

  let next = state;
  if (method === "error") {
    const error = asRecord(params.error);
    const message = typeof error?.message === "string" ? error.message : "";
    const details = typeof error?.additionalDetails === "string" ? error.additionalDetails : "";
    const combined = [message, details].filter((part) => part.length > 0).join(": ");
    if (combined.length > 0) {
      next = { ...state, lastErrorDetail: combined };
    }
  } else if (method === "turn/completed" && threadId === state.rootThreadId) {
    next = { ...state, lastErrorDetail: null };
  }
  return { state: next, commands: [event, ...links] };
}
