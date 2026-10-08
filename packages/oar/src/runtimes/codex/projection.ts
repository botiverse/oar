import type {
  FrameBody,
  RuntimeEventBody,
  SessionEdge,
  TurnOutcome,
} from "../../contracts/session.js";
import { codexFailure } from "./failure.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { noTokens } from "../../shared/token-totals.js";
import { codexItemExitCode, codexItemInput, codexToolContent } from "./item-detail.js";
import type { CodexOpenMethod } from "./open.js";
import { codexReasoningContent } from "./reasoning.js";
import { aboutOwnChild, codexTaskViews, withStartedChild, type SubagentThreads } from "./tasks.js";
import { baselineTokens, codexUsageViews, initialTokenBaseline, nextTokenBaseline, type CodexTokenBaseline } from "./token-usage.js";

/**
 * The codex notification → record projection as a PURE FOLD (see
 * runtimes/claude/projection.ts for the shape). Every notification becomes
 * exactly one frame command: verbatim `native`, events in oar's vocabulary,
 * the runtime's own turn id as `spanId`. Plus, for collaboration items that
 * name other threads, a link command for the session graph. Nothing is gated
 * on turn state and nothing is dropped; the adapter applies the commands and
 * separately owns the transport-only turn id (steer/abort identity), which is
 * not part of the projection. Behavior is pinned by tests/replay against
 * recorded fixtures.
 */

// `sleep` is the model waiting (`{durationMs}`, the wait it asked for; a steer
// can end it early). It reports no status, so its end carries no result.
const TOOL_ITEM_TYPES = new Set(["commandExecution", "fileChange", "mcpToolCall", "webSearch", "sleep"]);
const COLLAB_ITEM_TYPES = new Set(["collabAgentToolCall", "collabToolCall", "subAgentActivity"]);

export type ProjectionCommand =
  | {
      readonly kind: "frame";
      readonly body: FrameBody;
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
  /**
   * A root-thread compaction is open (its `contextCompaction` item started).
   * codex says "compacted" twice, as the item's completion and as the
   * deprecated `thread/compacted` notification ([env] 0.154.0 schema); the
   * flag lets the second report close nothing instead of ending twice.
   */
  readonly compacting: boolean;
  /** Subagent threads the stream reported starting: who started each, and its path. */
  readonly subagents: SubagentThreads;
  /** Where the root thread's token totals count from: this Session's opening (token-usage.ts). */
  readonly tokenBaseline: CodexTokenBaseline;
}

/** The projection of a Session opened by `opened`: a resume awaits codex's re-reported token total. */
export function initialCodexProjection(rootThreadId: string, opened: CodexOpenMethod = "thread/start"): CodexProjectionState {
  return { rootThreadId, lastErrorDetail: null, compacting: false, subagents: new Map(), tokenBaseline: initialTokenBaseline(opened === "thread/resume") };
}

const COMPACTION_ITEM_TYPE = "contextCompaction";

function isCompactionItem(params: JsonRecord): boolean {
  return asRecord(params.item)?.type === COMPACTION_ITEM_TYPE;
}

// The runtime's own status is the truth: an interrupt that landed reports
// "interrupted"; one that lost the race to completion reports "completed".
// A failure is classified from the turn's own error (failure.ts).
function outcomeFromTurn(state: CodexProjectionState, turn: JsonRecord | null): TurnOutcome {
  const status = turn?.status;
  switch (status) {
    case "interrupted":
      return { kind: "aborted" };
    case "completed":
      return { kind: "completed" };
    default: {
      const word = typeof status === "string" ? status : "unknown";
      const reason = state.lastErrorDetail === null ? word : `${word}: ${state.lastErrorDetail}`;
      return codexFailure(reason, turn?.error);
    }
  }
}

function toolViews(method: string, item: JsonRecord | null): RuntimeEventBody[] {
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
  const content = item === null ? undefined : codexToolContent(item);
  const exitCode = item === null ? undefined : codexItemExitCode(item);
  const status = typeof item?.status === "string" ? item.status : undefined;
  let result: "ok" | "failed" | undefined = undefined;
  if (status === "completed") {
    result = "ok";
  } else if (status === "failed") {
    result = "failed";
  }
  return [{
    kind: "tool_call_ended",
    callId: itemId,
    ...(content === undefined ? {} : { content }),
    ...(result === undefined ? {} : { result }),
    ...(exitCode === undefined ? {} : { exitCode }),
  }];
}

/**
 * `thread/settings/updated` is codex's own report of the thread's settings
 * after a change ([env] 0.155.1: pushed when a turn/start carries an `effort`
 * or `model` override, "for this turn and subsequent turns"):
 * `threadSettings.model` and `threadSettings.effort` (null: no explicit
 * level) are the model and effort now in effect.
 */
function settingsViews(params: JsonRecord): RuntimeEventBody[] {
  const settings = asRecord(params.threadSettings);
  const events: RuntimeEventBody[] = [];
  if (typeof settings?.model === "string" && settings.model.length > 0) {
    events.push({ kind: "model", model: settings.model });
  }
  if (typeof settings?.effort === "string" && settings.effort.length > 0) {
    events.push({ kind: "effort", effort: settings.effort });
  }
  return events;
}

/** Edges a collaboration item establishes: the sender thread (the reporting thread unless the item names one) spawned or addressed the named threads. */
function collabEdges(state: CodexProjectionState, reporter: string, item: JsonRecord | null): SessionEdge[] {
  if (item === null || typeof item.type !== "string" || !COLLAB_ITEM_TYPES.has(item.type)) {
    return [];
  }
  if (item.type === "subAgentActivity" && !aboutOwnChild(state.subagents, state.rootThreadId, reporter, item)) {
    return [];
  }
  const parent = typeof item.senderThreadId === "string" ? item.senderThreadId : reporter;
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

function viewsFor(state: CodexProjectionState, reporter: string, method: string, params: JsonRecord): RuntimeEventBody[] {
  switch (method) {
    case "item/agentMessage/delta":
      // `itemId` names the agentMessage item: one turn can say several.
      return typeof params.delta === "string"
        ? [{ kind: "text_delta", text: params.delta, ...(typeof params.itemId === "string" ? { messageId: params.itemId } : {}) }]
        : [];
    case "item/commandExecution/outputDelta":
      // Streamed stdout of a running command item; `itemId` is the tool call.
      return typeof params.itemId === "string"
        ? [{ kind: "tool_call_progress", callId: params.itemId, ...(typeof params.delta === "string" ? { output: params.delta } : {}) }]
        : [];
    case "thread/compacted":
      return state.compacting ? [{ kind: "compaction_ended", outcome: "completed" }] : [];
    case "rawResponseItem/completed": {
      const content = codexReasoningContent(asRecord(params.item));
      return content === null ? [] : [{ kind: "reasoning", content }];
    }
    case "item/started": {
      const item = asRecord(params.item);
      if (item?.type === "userMessage" && Array.isArray(item.content)) {
        const input = item.content.map((part: unknown) => asRecord(part)).filter((part) => part?.type === "text").map((part) => typeof part?.text === "string" ? part.text : "").join("");
        return [{ kind: "user_message", input, evidence: "turn_item",
          ...(typeof item.clientId === "string" ? { inputId: item.clientId } : {}),
          ...(typeof item.id === "string" ? { nativeMessageId: item.id } : {}),
          ...(typeof params.turnId === "string" ? { turnId: params.turnId } : {}),
        }];
      }
      return isCompactionItem(params) ? [{ kind: "compaction_started" }] : toolViews(method, asRecord(params.item));
    }
    case "item/completed": {
      if (isCompactionItem(params)) {
        return [{ kind: "compaction_ended", outcome: "completed" }];
      }
      const item = asRecord(params.item);
      if (item?.type === "subAgentActivity") {
        return aboutOwnChild(state.subagents, state.rootThreadId, reporter, item) ? codexTaskViews(item) : [];
      }
      return toolViews(method, item);
    }
    case "turn/completed":
      return [{ kind: "turn_ended", outcome: outcomeFromTurn(state, asRecord(params.turn)) }];
    case "thread/tokenUsage/updated":
      return codexUsageViews(params, reporter === state.rootThreadId ? baselineTokens(state.tokenBaseline) : noTokens);
    case "thread/settings/updated":
      return settingsViews(params);
    default:
      return [];
  }
}

/** Fold one codex notification into the next state plus commands. */
export function foldCodexNotification(
  previous: CodexProjectionState,
  method: string,
  params: JsonRecord,
): { readonly state: CodexProjectionState; readonly commands: readonly ProjectionCommand[] } {
  const threadId = typeof params.threadId === "string" ? params.threadId : previous.rootThreadId;
  // Before the views: a re-reported total is read against itself (zero).
  const tokenBaseline = threadId === previous.rootThreadId ? nextTokenBaseline(previous.tokenBaseline, method, params) : previous.tokenBaseline;
  const state = tokenBaseline === previous.tokenBaseline ? previous : { ...previous, tokenBaseline };
  const spanId = spanIdOf(params);
  const event: ProjectionCommand = {
    kind: "frame",
    body: { type: method, native: params, events: viewsFor(state, threadId, method, params) },
    ...(spanId === undefined ? {} : { spanId }),
    ...(threadId === state.rootThreadId ? {} : { sessionId: threadId }),
  };
  const links = method === "item/started" || method === "item/completed"
    ? collabEdges(state, threadId, asRecord(params.item)).map((edge): ProjectionCommand => ({ kind: "link", edge }))
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
  } else if (threadId === state.rootThreadId && isCompactionItem(params) && (method === "item/started" || method === "item/completed")) {
    next = { ...state, compacting: method === "item/started" };
  } else if (method === "thread/compacted" && threadId === state.rootThreadId) {
    next = { ...state, compacting: false };
  }
  const subagents = withStartedChild(next.subagents, threadId, asRecord(params.item));
  if (subagents !== next.subagents) {
    next = { ...next, subagents };
  }
  return { state: next, commands: [event, ...links] };
}
