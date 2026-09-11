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
 * exactly one event command — verbatim `native`, views in oar's vocabulary,
 * the runtime's own turn id as `spanId` — plus, for collaboration items that
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
      /** Set when the notification belongs to another thread — a derived child session. */
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

function usageViews(params: JsonRecord): EventView[] {
  const total = asRecord(asRecord(params.tokenUsage)?.total);
  if (total === null) {
    return [];
  }
  const input = asNumber(total.inputTokens);
  const output = asNumber(total.outputTokens);
  return [{
    kind: "usage",
    usage: {
      context: { tokens: input, contextWindow: null, percent: null },
      ...(input === null || output === null ? {} : { tokens: { input, output } }),
    },
  }];
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
    const combined = [message, details].filter((part) => part.length > 0).join(" — ");
    if (combined.length > 0) {
      next = { ...state, lastErrorDetail: combined };
    }
  } else if (method === "turn/completed" && threadId === state.rootThreadId) {
    next = { ...state, lastErrorDetail: null };
  }
  return { state: next, commands: [event, ...links] };
}
