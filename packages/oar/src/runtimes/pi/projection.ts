import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type {
  ContextUsage,
  EventBody,
  EventView,
  TokenTotals,
  TurnOutcome,
} from "../../contracts/session.js";
import { classifyFailure } from "../../shared/failure-class.js";
import { asNumber, asRecord } from "../../shared/json.js";

/**
 * The pi SDK-event → record projection as a PURE FOLD (see
 * runtimes/claude/projection.ts). Every SDK event becomes exactly ONE event
 * command: the event object verbatim as `native`, `type` = its SDK type, and
 * the views oar read out of it. Nothing is gated on turn state and nothing
 * is dropped; the session-scoped events (compaction, queue, retry, …)
 * enter the stream with no views, inside the turn they belong to. pi has no native turn id (no spanId) and no native sub-agents
 * (agentPath is always root).
 *
 * `abortRequested` / `providerError` are control-plane and error inputs the
 * provider stream alone does not carry; `tokens` is the running per-session
 * total so usage views are cumulative, as the contract requires.
 */

export interface ProjectionCommand {
  readonly kind: "event";
  readonly body: EventBody;
}

export interface PiProjectionState {
  readonly abortRequested: boolean;
  readonly reasoningHadText: boolean;
  readonly providerError: string | undefined;
  readonly tokens: TokenTotals;
}

export const initialPiProjection: PiProjectionState = {
  abortRequested: false,
  reasoningHadText: false,
  providerError: undefined,
  tokens: { input: 0, output: 0 },
};

/** Control plane → state: a prompt (or a drained queue input) resets the per-run accumulators; the running token total stays. */
export function piPrompted(state: PiProjectionState): PiProjectionState {
  return { ...initialPiProjection, tokens: state.tokens };
}

export function piAbortRequested(state: PiProjectionState): PiProjectionState {
  return { ...state, abortRequested: true };
}

/** The outcome of the run pi's own `agent_settled` closes, read through the control intent and provider errors folded so far. */
export function piRunOutcome(state: PiProjectionState): TurnOutcome {
  if (state.abortRequested) {
    return { kind: "aborted" };
  }
  if (state.providerError !== undefined) {
    return { kind: "failed", reason: state.providerError, failure: classifyFailure(state.providerError) };
  }
  return { kind: "completed" };
}

/** Extra inputs the adapter supplies alongside an SDK event: pi's authoritative context fullness, read at `agent_settled`. */
export interface PiFoldExtra {
  readonly context?: ContextUsage | null;
}

interface Step {
  readonly state: PiProjectionState;
  readonly views: readonly EventView[];
}

function jsonDetail(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function foldMessageUpdate(
  state: PiProjectionState,
  inner: Extract<AgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"],
): Step {
  switch (inner.type) {
    case "text_delta":
      return { state, views: [{ kind: "text_delta", text: inner.delta }] };
    case "thinking_delta":
      return inner.delta.length > 0
        ? { state: { ...state, reasoningHadText: true }, views: [{ kind: "reasoning", content: { kind: "text", text: inner.delta } }] }
        : { state, views: [] };
    case "error":
      // pi's prompt() RESOLVES even when the provider errored; the failure
      // only surfaces here (pinned by the pi vendor 400 test).
      return { state: { ...state, providerError: inner.error.errorMessage ?? inner.reason }, views: [] };
    case "thinking_start":
      return { state: { ...state, reasoningHadText: false }, views: [] };
    case "thinking_end":
      return state.reasoningHadText ? { state, views: [] } : { state, views: [{ kind: "reasoning", content: { kind: "empty" } }] };
    // Block boundaries and toolcall framing carry no view (toolcalls arrive
    // via the outer tool_execution_* events); the frame itself is recorded.
    case "start":
    case "done":
    case "text_start":
    case "text_end":
    case "toolcall_start":
    case "toolcall_delta":
    case "toolcall_end":
      return { state, views: [] };
  }
  return { state, views: [] };
}

/** Cumulative per-session tokens after an assistant message's own usage. */
function accumulate(state: PiProjectionState, message: unknown): Step {
  const record = asRecord(message);
  const usage = asRecord(record?.usage);
  if (record?.role !== "assistant" || usage === null) {
    return { state, views: [] };
  }
  const tokens: TokenTotals = {
    input: state.tokens.input + (asNumber(usage.input) ?? 0) + (asNumber(usage.cacheRead) ?? 0) + (asNumber(usage.cacheWrite) ?? 0),
    output: state.tokens.output + (asNumber(usage.output) ?? 0),
  };
  return { state: { ...state, tokens }, views: [{ kind: "usage", usage: { tokens } }] };
}

function step(state: PiProjectionState, event: AgentSessionEvent, extra: PiFoldExtra): Step {
  switch (event.type) {
    case "agent_settled": {
      // pi's run-settled signal (agent-session.js _emitAgentSettled: it
      // flips _isAgentRunActive off) is the turn's end, NOT agent_end, which
      // precedes threshold compaction and auto-retries; between the two pi
      // rejects new prompts ("Cannot submit a prompt while compaction is in
      // progress"). The context read here is therefore post-compaction.
      const views: EventView[] = [{ kind: "turn_ended", outcome: piRunOutcome(state) }];
      if (extra.context !== undefined && extra.context !== null) {
        views.push({ kind: "usage", usage: { context: extra.context } });
      }
      return { state: piPrompted(state), views };
    }
    case "message_update":
      return foldMessageUpdate(state, event.assistantMessageEvent);
    case "message_end":
      return accumulate(state, event.message);
    case "tool_execution_start": {
      const input = jsonDetail(event.args);
      return { state, views: [input === undefined
        ? { kind: "tool_call_started", callId: event.toolCallId, tool: event.toolName }
        : { kind: "tool_call_started", callId: event.toolCallId, tool: event.toolName, input }] };
    }
    case "tool_execution_end": {
      const output = jsonDetail(event.result);
      const result = typeof event.isError === "boolean" ? (event.isError ? "failed" as const : "ok" as const) : undefined;
      return { state, views: [output === undefined
        ? { kind: "tool_call_ended", callId: event.toolCallId, ...(result === undefined ? {} : { result }) }
        : { kind: "tool_call_ended", callId: event.toolCallId, output, ...(result === undefined ? {} : { result }) }] };
    }
    case "turn_end":
      // A provider failure surfaces only as stopReason "error" on the turn's
      // final assistant message (pinned by the pi vendor 400 test).
      return event.message.role === "assistant" && event.message.stopReason === "error"
        ? { state: { ...state, providerError: event.message.errorMessage ?? "provider error" }, views: [] }
        : { state, views: [] };
    // Recorded with no view (an exhaustive switch makes a NEW pi event type a
    // compile error, forcing a conscious viewed-or-plain decision on each
    // future addition).
    case "agent_start":
    case "agent_end":
    case "turn_start":
    case "message_start":
    case "tool_execution_update":
    case "bash_execution_update":
    case "compaction_start":
    case "compaction_end":
    case "queue_update":
    case "entry_appended":
    case "session_info_changed":
    case "thinking_level_changed":
    case "auto_retry_start":
    case "auto_retry_end":
    case "summarization_retry_scheduled":
    case "summarization_retry_attempt_start":
    case "summarization_retry_finished":
      return { state, views: [] };
  }
  return { state, views: [] };
}

/** Fold one pi SDK event into the next state plus the one event command it produces. */
export function foldPiEvent(
  state: PiProjectionState,
  event: AgentSessionEvent,
  extra: PiFoldExtra = {},
): { readonly state: PiProjectionState; readonly commands: readonly ProjectionCommand[] } {
  const next = step(state, event, extra);
  return {
    state: next.state,
    commands: [{ kind: "event", body: { type: event.type, native: event, views: next.views } }],
  };
}
