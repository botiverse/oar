/* oxlint-disable import/max-dependencies -- Claude composes its native usage, context, failure and task meanings with the shared protocol. */
import { claudeServiceTierEvents } from "./service-tier.js";
import type { UtcInstant } from "../../contracts/account-usage.js";
import type { RuntimeEventBody, TokenTotals, TurnOutcome } from "../../contracts/session.js";
import { claudeFailure, claudeLimitReset, claudeResultReason } from "./failure.js";
import { asNumber, asRecord, type JsonRecord } from "../../shared/json.js";
import { claudeContextCompacted, claudeContextSent, claudeContextUsage, initialClaudeContext, type ClaudeContextReading } from "./context-usage.js";
import { foldModelUsage, freshModelUsage, resumedModelUsage, withBaseline, withMainLoop, type ClaudeModelUsage, type ClaudeUsageBaseline } from "./token-usage.js";
import { claudeTaskViews } from "./tasks.js";
import { foldStreamJsonStdout, type ProjectionCommand } from "../../shared/stream-json/projection.js";
import { initialStreamJsonProjection, streamJsonAbortRequested, type StreamJsonProjectionState } from "../../shared/stream-json/state.js";
import type { StreamJsonProjectionProfile } from "../../shared/stream-json/profile.js";

export type { ProjectionCommand } from "../../shared/stream-json/projection.js";

/** Claude's usage baselines, native context and failure/task reports extend the protocol state. */
export interface ClaudeProjectionState extends StreamJsonProjectionState {
  readonly tokens: ReadonlyMap<string, TokenTotals>;
  readonly modelUsage: ClaudeModelUsage;
  readonly context: ClaudeContextReading;
  readonly taskDescriptions: ReadonlyMap<string, string>;
  readonly failureCategory: string | null;
  readonly limitResetsAt: UtcInstant | null;
}

export const initialClaudeProjection: ClaudeProjectionState = {
  ...initialStreamJsonProjection,
  tokens: new Map(),
  modelUsage: freshModelUsage,
  context: initialClaudeContext,
  taskDescriptions: new Map(),
  failureCategory: null,
  limitResetsAt: null,
};

/** A resumed session's fold: it counts no tokens until `claudeUsageBaselined` says where its share starts. */
export const resumedClaudeProjection: ClaudeProjectionState = { ...initialClaudeProjection, modelUsage: resumedModelUsage };

/** The adapter's `get_usage` read-back at open: where a resumed Session's share of claude's running total starts. */
export function claudeUsageBaselined(state: ClaudeProjectionState, baseline: ClaudeUsageBaseline): ClaudeProjectionState {
  return { ...state, modelUsage: withBaseline(state.modelUsage, baseline) };
}

export { streamJsonPrompted as claudePrompted } from "../../shared/stream-json/input-lifecycle.js";

export const claudeAbortRequested = streamJsonAbortRequested<ClaudeProjectionState>;

function resultOutcome(state: ClaudeProjectionState, message: JsonRecord): TurnOutcome {
  if (state.abortRequested) {
    return { kind: "aborted" };
  }
  if (message.is_error === true) {
    // Vendor quirk (pinned 2026-08-22): claude can report is_error=true with
    // subtype "success" and put the actual error text in result.
    const text = typeof message.result === "string" && message.result.length > 0
      ? message.result
      : undefined;
    const subtype = typeof message.subtype === "string" && message.subtype !== "success"
      ? message.subtype
      : undefined;
    return claudeFailure(text ?? claudeResultReason(subtype, message.errors), {
      category: state.failureCategory,
      status: asNumber(message.api_error_status),
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

export const claudeProjectionProfile: StreamJsonProjectionProfile<ClaudeProjectionState> = {
  name: "claude",
  duplicateReason: "claude ignored the input: its inputId was already used in this session",
  assistant: (state, message, root) => root ? { ...state, failureCategory: typeof message.error === "string" ? message.error : state.failureCategory, context: claudeContextSent(state.context, message) } : state,
  result: (state, message, agentPath) => {
    const accumulated = accumulate(state, agentPath, message);
    const running = foldModelUsage(state.modelUsage, message);
    const { context, reading } = claudeContextUsage(state.context, message);
    const after: RuntimeEventBody[] = [];
    if (accumulated !== null || context !== null || running.total !== null) {
      after.push({ kind: "usage", usage: {
        ...(context === null ? {} : { context }),
        ...(accumulated === null ? {} : { tokens: accumulated.tokens }),
        ...(running.total === null ? {} : { total: running.total }),
      } });
    }
    return { state: { ...(accumulated?.state ?? state), modelUsage: running.usage, context: reading, failureCategory: null },
      outcome: resultOutcome(state, message), before: claudeServiceTierEvents(message), after };
  },
  init: claudeServiceTierEvents,
  compacted: (state, root) => root ? { ...state, context: claudeContextCompacted(state.context) } : state,
  system: (state, message, agentPath) => {
    const task = claudeTaskViews(message, state.taskDescriptions, agentPath);
    return { events: [...task.events, ...claudeServiceTierEvents(message)],
      state: task.descriptions === state.taskDescriptions ? state : { ...state, taskDescriptions: task.descriptions } };
  },
  other: (state, message) => ({ events: [], state: message.type === "rate_limit_event" ? { ...state, limitResetsAt: claudeLimitReset(asRecord(message.rate_limit_info)) } : state }),
};

/** The same runtime profile is used for live frames and offline replay. */
export function foldClaudeStdout(state: ClaudeProjectionState, message: JsonRecord): { readonly state: ClaudeProjectionState; readonly commands: readonly ProjectionCommand[] } {
  return foldStreamJsonStdout(claudeProjectionProfile, state, message);
}
