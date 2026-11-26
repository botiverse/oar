/* oxlint-disable import/max-dependencies -- Claude composes its native usage, context, failure and task meanings with the shared protocol. */
import { claudeServiceTierEvents } from "./service-tier.js";
import type { UtcInstant } from "../../contracts/account-usage.js";
import type { RuntimeEventBody, TokenTotals, TurnOutcome } from "../../contracts/session.js";
import { claudeFailure, claudeLimitReset, claudeResultReason, claudeSyntheticAssistant } from "./failure.js";
import { asNumber, asRecord, type JsonRecord } from "../../shared/json.js";
import { claudeContextCompacted, claudeContextSent, claudeContextUsage, initialClaudeContext, type ClaudeContextReading } from "./context-usage.js";
import { foldModelUsage, freshModelUsage, resumedModelUsage, withBaseline, withMainLoop, type ClaudeModelUsage, type ClaudeUsageBaseline } from "./token-usage.js";
import { claudeTaskViews } from "./tasks.js";
import { foldStreamJsonStdout, type ProjectionCommand } from "../../shared/stream-json/projection.js";
import { initialStreamJsonProjection, streamJsonAbortRequested, type StreamJsonProjectionState } from "../../shared/stream-json/state.js";
import type { StreamJsonProjectionProfile } from "../../shared/stream-json/profile.js";
import { contentBlocks } from "../../shared/stream-json/content.js";
import { claudeChecklistTool } from "./plan.js";

export type { ProjectionCommand } from "../../shared/stream-json/projection.js";

/** Claude's usage baselines, native context and failure/task reports extend the protocol state. */
export interface ClaudeProjectionState extends StreamJsonProjectionState {
  readonly tokens: ReadonlyMap<string, TokenTotals>;
  readonly modelUsage: ClaudeModelUsage;
  readonly context: ClaudeContextReading;
  readonly taskDescriptions: ReadonlyMap<string, string>;
  /** Last error or refusal per agent, cleared on settlement or a later ordinary assistant. */
  readonly assistantFailures: ReadonlyMap<string, JsonRecord>;
  readonly limitResetsAt: UtcInstant | null;
  /**
   * The turn's fork anchor (`--resume-session-at`, launch.ts), stamped on its
   * `turn_ended` and cleared there: the `uuid` of the latest root assistant
   * message since the last root result, or null when that message holds a
   * `tool_use` block or a root `tool_result` followed it. A fork through a
   * `tool_use` drops the saved `tool_result`, and claude answers the call
   * with `[Tool result missing due to internal error]` instead ([env]
   * 2.1.323: the aborted turn's interrupted call, an `outputSchema` turn's
   * `StructuredOutput` call, an `error_max_turns` turn's last tool call;
   * sea-trial/vendor/session-fork-cases.vendor.test.ts). An aborted turn
   * gets none either. An API-error failure's anchor is the synthetic
   * `API Error` message claude saves under that uuid; a fork through it
   * carries the source's history.
   */
  readonly lastAssistantUuid: string | null;
}

export const initialClaudeProjection: ClaudeProjectionState = {
  ...initialStreamJsonProjection,
  tokens: new Map(),
  modelUsage: freshModelUsage,
  context: initialClaudeContext,
  taskDescriptions: new Map(),
  assistantFailures: new Map(),
  limitResetsAt: null,
  lastAssistantUuid: null,
};

/** A resumed session's fold: it counts no tokens until `claudeUsageBaselined` says where its share starts. */
export const resumedClaudeProjection: ClaudeProjectionState = { ...initialClaudeProjection, modelUsage: resumedModelUsage };

/** The adapter's `get_usage` read-back at open: where a resumed Session's share of claude's running total starts. */
export function claudeUsageBaselined(state: ClaudeProjectionState, baseline: ClaudeUsageBaseline): ClaudeProjectionState {
  return { ...state, modelUsage: withBaseline(state.modelUsage, baseline) };
}

export { streamJsonPrompted as claudePrompted } from "../../shared/stream-json/input-lifecycle.js";

export const claudeAbortRequested = streamJsonAbortRequested<ClaudeProjectionState>;

function resultOutcome(state: ClaudeProjectionState, message: JsonRecord, assistant: JsonRecord | undefined): TurnOutcome {
  if (state.abortRequested) {
    return { kind: "aborted" };
  }
  const synthetic = assistant !== undefined && claudeSyntheticAssistant(assistant);
  const diagnostic = synthetic ? contentBlocks(assistant).flatMap(block => block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n") : "";
  // [env] Claude 2.1.326/2.1.328 (failure-classes.vendor.test.ts): stop_reason "refusal" precedes synthetic invalid_request.
  if (message.stop_reason === "refusal" || asRecord(assistant?.message)?.stop_reason === "refusal") {
    const reason = diagnostic || (typeof message.result === "string" && message.result.length > 0 ? message.result : "refusal");
    return { kind: "failed", failure: "model_refused", reason };
  }
  if (message.is_error === true || (synthetic && (assistant.is_api_error_message === true || typeof assistant.error === "string"))) {
    // Vendor quirk (pinned 2026-08-22): claude can report is_error=true with
    // subtype "success" and put the actual error text in result.
    const text = typeof message.result === "string" && message.result.length > 0
      ? message.result
      : undefined;
    const subtype = typeof message.subtype === "string" && message.subtype !== "success"
      ? message.subtype
      : undefined;
    return claudeFailure(diagnostic || (text ?? claudeResultReason(subtype, message.errors)), {
      category: typeof assistant?.error === "string" ? assistant.error : null,
      apiError: assistant?.api_error,
      rateLimitInfo: asRecord(asRecord(assistant?.api_error_params)?.rate_limit_info),
      status: asNumber(message.api_error_status) ?? asNumber(assistant?.api_error_status),
      terminalReason: typeof message.terminal_reason === "string" ? message.terminal_reason : null,
      limitResetsAt: state.limitResetsAt,
      subtype: subtype ?? null,
    });
  }
  return { kind: "completed", ...(Object.hasOwn(message, "structured_output") ? { structuredOutput: message.structured_output } : {}) };
}

function pathKey(agentPath: readonly string[]): string {
  return JSON.stringify(agentPath);
}

/**
 * Cumulative per-agent tokens after folding this result frame's own turn
 * usage: the main loop's (claude's word), so the root agent's. None while a
 * resumed Session's share is unknown. Subagents get no entry: only a
 * subagent's first assistant frame carries `parent_tool_use_id`, and its
 * `message.usage` is the stream-start value, not final ([env] 2.1.292), so
 * their spend stays in the session total, unattributed.
 */
function accumulate(state: ClaudeProjectionState, agentPath: readonly string[], message: JsonRecord): { state: ClaudeProjectionState; tokens: TokenTotals } | null {
  const tokens = state.modelUsage.baseline.kind === "known" ? withMainLoop(state.tokens.get(pathKey(agentPath)), message) : null;
  if (tokens === null) {
    return null;
  }
  const next = new Map([...state.tokens, [pathKey(agentPath), tokens]]);
  return { state: { ...state, tokens: next }, tokens };
}

/** The anchor after a root assistant message: none past a `tool_use` (ClaudeProjectionState.lastAssistantUuid), else its uuid. */
function assistantAnchor(previous: string | null, message: JsonRecord): string | null {
  if (contentBlocks(message).some((block) => block.type === "tool_use")) { return null; }
  return typeof message.uuid === "string" && message.uuid.length > 0 ? message.uuid : previous;
}

export const claudeProjectionProfile: StreamJsonProjectionProfile<ClaudeProjectionState> = {
  name: "claude",
  childAssistantModel: true,
  checklistTool: claudeChecklistTool,
  compactingStatus: true,
  duplicateReason: "claude ignored the input: its inputId was already used in this session",
  isAssistantError: claudeSyntheticAssistant,
  assistant: (state, message, agentPath) => {
    const key = pathKey(agentPath);
    const failed = claudeSyntheticAssistant(message) || typeof message.error === "string" || asRecord(message.message)?.stop_reason === "refusal";
    let assistantFailures = state.assistantFailures;
    if (failed) { assistantFailures = new Map(assistantFailures).set(key, message); }
    else if (assistantFailures.has(key)) { const remaining = new Map(assistantFailures); remaining.delete(key); assistantFailures = remaining; }
    return agentPath.length === 0 ? { ...state, assistantFailures, context: claudeContextSent(state.context, message),
      lastAssistantUuid: assistantAnchor(state.lastAssistantUuid, message) } : { ...state, assistantFailures };
  },
  user: (state, message, root) => root && state.lastAssistantUuid !== null && contentBlocks(message).some((block) => block.type === "tool_result") ? { ...state, lastAssistantUuid: null } : state,
  result: (state, message, agentPath) => {
    const accumulated = accumulate(state, agentPath, message);
    const running = foldModelUsage(state.modelUsage, message);
    const { context, cacheWriteByTtl, reading } = claudeContextUsage(state.context, message);
    const before: RuntimeEventBody[] = [...claudeServiceTierEvents(message)];
    if (accumulated !== null || context !== null || running.total !== null || cacheWriteByTtl !== undefined) {
      before.push({ kind: "usage", usage: {
        ...(context === null ? {} : { context }),
        ...(accumulated === null ? {} : { tokens: accumulated.tokens }),
        ...(running.total === null ? {} : { total: running.total }),
        ...(cacheWriteByTtl === undefined ? {} : { cacheWriteByTtl }),
      } });
    }
    const root = agentPath.length === 0;
    const key = pathKey(agentPath);
    const outcome = resultOutcome(state, message, state.assistantFailures.get(key));
    const remaining = new Map(state.assistantFailures);
    remaining.delete(key);
    // No anchor on an aborted turn: a fork through it loses the interruption (lastAssistantUuid).
    const anchor = root && outcome.kind !== "aborted" ? state.lastAssistantUuid : null;
    return { state: { ...(accumulated?.state ?? state), modelUsage: running.usage, context: reading, assistantFailures: remaining, ...(root ? { lastAssistantUuid: null } : {}) },
      outcome, before, ...(anchor === null ? {} : { forkAnchor: anchor }) };
  },
  init: claudeServiceTierEvents,
  compacted: (state, root) => root ? { ...state, context: claudeContextCompacted(state.context) } : state,
  system: (state, message, agentPath) => {
    const task = claudeTaskViews(message, state.taskDescriptions, agentPath);
    const events = [...task.events, ...claudeServiceTierEvents(message)];
    if (message.subtype === "status" && message.compact_result === "failed") {
      events.push({ kind: "compaction_ended", outcome: "failed", ...(typeof message.compact_error === "string" ? { reason: message.compact_error } : {}) });
    }
    return { events,
      state: task.descriptions === state.taskDescriptions ? state : { ...state, taskDescriptions: task.descriptions } };
  },
  other: (state, message) => ({ events: [], state: message.type === "rate_limit_event" ? { ...state, limitResetsAt: claudeLimitReset(asRecord(message.rate_limit_info)) } : state }),
};

/** The same runtime profile is used for live frames and offline replay. */
export function foldClaudeStdout(state: ClaudeProjectionState, message: JsonRecord): { readonly state: ClaudeProjectionState; readonly commands: readonly ProjectionCommand[] } {
  return foldStreamJsonStdout(claudeProjectionProfile, state, message);
}
