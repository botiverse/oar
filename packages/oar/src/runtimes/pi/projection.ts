import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type {
  ContextUsage,
  FrameBody,
  RuntimeEventBody,
  TokenTotals,
  TurnOutcome,
} from "../../contracts/session.js";
import { piFailure, type PiProviderError } from "./failure.js";
import { asNumber, asRecord } from "../../shared/json.js";
import { addTokens, cacheParts, noTokens } from "../../shared/token-totals.js";
import { toolContent } from "../../shared/tool-output.js";

/**
 * The pi SDK-event → record projection as a PURE FOLD (see
 * runtimes/claude/projection.ts). Every SDK event becomes exactly ONE event
 * command: the event object verbatim as `native`, `type` = its SDK type, and
 * the events oar read out of it. Nothing is gated on turn state and nothing
 * is dropped; the session-scoped events (compaction, queue, retry, …)
 * enter the stream with no events, inside the turn they belong to. pi has no native turn id (no spanId) and no native sub-agents
 * (agentPath is always root).
 *
 * `providerError` retains failures from the provider stream; `tokens` is the running total of
 * this Session's assistant messages, so usage events count from when this
 * Session opened, as the contract requires.
 */

export interface ProjectionCommand {
  readonly kind: "frame";
  readonly body: FrameBody;
}

export interface PiProjectionState {
  readonly reasoningHadText: boolean;
  readonly providerError: PiProviderError | undefined;
  readonly tokens: TokenTotals;
}

export const initialPiProjection: PiProjectionState = {
  reasoningHadText: false,
  providerError: undefined,
  tokens: noTokens,
};

/** Control plane → state: a prompt (or a drained queue input) resets the per-run accumulators; the running token total stays. */
export function piPrompted(state: PiProjectionState): PiProjectionState {
  return { ...initialPiProjection, tokens: state.tokens };
}

/** Pi's settlement reports cancellation; preceding provider events supply error details. */
export function piRunOutcome(state: PiProjectionState, aborted: boolean): TurnOutcome {
  if (aborted) {
    return { kind: "aborted" };
  }
  if (state.providerError !== undefined) {
    return piFailure(state.providerError);
  }
  return { kind: "completed" };
}

/**
 * Extra inputs the adapter supplies alongside an SDK event: pi's
 * authoritative context fullness, read at `agent_settled`; and whether the
 * failed assistant message the event carries is a context overflow (pi-ai's
 * `isContextOverflow`, which the adapter loads with the SDK).
 */
export interface PiFoldExtra {
  readonly context?: ContextUsage | null;
  readonly overflow?: boolean;
}

interface Step {
  readonly state: PiProjectionState;
  readonly events: readonly RuntimeEventBody[];
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
  overflow: boolean,
): Step {
  switch (inner.type) {
    case "text_delta":
      return { state, events: [{ kind: "text_delta", text: inner.delta }] };
    case "thinking_delta":
      return inner.delta.length > 0
        ? { state: { ...state, reasoningHadText: true }, events: [{ kind: "reasoning", content: { kind: "text", text: inner.delta } }] }
        : { state, events: [] };
    case "error":
      // pi's prompt() RESOLVES even when the provider errored; the failure
      // only surfaces here (pinned by the pi vendor 400 test).
      return { state: { ...state, providerError: { message: inner.error.errorMessage ?? inner.reason, overflow } }, events: [] };
    case "thinking_start":
      return { state: { ...state, reasoningHadText: false }, events: [] };
    case "thinking_end":
      return state.reasoningHadText ? { state, events: [] } : { state, events: [{ kind: "reasoning", content: { kind: "empty" } }] };
    // Block boundaries and toolcall framing carry no event (toolcalls arrive
    // via the outer tool_execution_* events); the frame itself is recorded.
    case "start":
    case "done":
    case "text_start":
    case "text_end":
    case "toolcall_start":
    case "toolcall_delta":
    case "toolcall_end":
      return { state, events: [] };
  }
  return { state, events: [] };
}

/** Cumulative per-session tokens after an assistant message's own usage. */
function accumulate(state: PiProjectionState, message: unknown): Step {
  const record = asRecord(message);
  const usage = asRecord(record?.usage);
  if (record?.role !== "assistant" || usage === null) {
    return { state, events: [] };
  }
  // pi's `input` excludes the cache reads and writes, so input counts them
  // back in; each also stands as its own part (`cacheWrite1h` is a subset of
  // `cacheWrite`, pi-ai types.d.ts, so it adds nothing).
  const cache = cacheParts(usage, { read: "cacheRead", write: "cacheWrite" });
  const tokens = addTokens(state.tokens, {
    input: (asNumber(usage.input) ?? 0) + (cache.cacheRead ?? 0) + (cache.cacheWrite ?? 0),
    output: asNumber(usage.output) ?? 0,
    ...cache,
  });
  return { state: { ...state, tokens }, events: [{ kind: "usage", usage: { tokens } }] };
}

function step(state: PiProjectionState, event: AgentSessionEvent, extra: PiFoldExtra): Step {
  switch (event.type) {
    case "agent_settled": {
      // pi's run-settled signal (agent-session.js _emitAgentSettled: it
      // flips _isAgentRunActive off) is the turn's end, NOT agent_end, which
      // precedes threshold compaction and auto-retries; between the two pi
      // rejects new prompts ("Cannot submit a prompt while compaction is in
      // progress"). The context read here is therefore post-compaction.
      const events: RuntimeEventBody[] = [{ kind: "turn_ended", outcome: piRunOutcome(state, event.aborted) }];
      if (extra.context !== undefined && extra.context !== null) {
        events.push({ kind: "usage", usage: { context: extra.context } });
      }
      return { state: piPrompted(state), events };
    }
    case "message_update":
      return foldMessageUpdate(state, event.assistantMessageEvent, extra.overflow === true);
    case "message_end":
      return accumulate(state, event.message);
    case "tool_execution_start": {
      const input = jsonDetail(event.args);
      return { state, events: [input === undefined
        ? { kind: "tool_call_started", callId: event.toolCallId, tool: event.toolName }
        : { kind: "tool_call_started", callId: event.toolCallId, tool: event.toolName, input }] };
    }
    case "tool_execution_update": {
      const output = jsonDetail(event.partialResult);
      return { state, events: [output === undefined
        ? { kind: "tool_call_progress", callId: event.toolCallId }
        : { kind: "tool_call_progress", callId: event.toolCallId, output }] };
    }
    case "compaction_start":
      return { state, events: [{ kind: "compaction_started", trigger: event.reason }] };
    case "compaction_end": {
      // pi's own flags decide: aborted wins, then an error message, else done.
      // `willRetry` means pi will try again; the retry announces itself.
      let outcome: "completed" | "aborted" | "failed" = "completed";
      if (event.aborted) {
        outcome = "aborted";
      } else if (event.errorMessage !== undefined) {
        outcome = "failed";
      }
      return { state, events: [{ kind: "compaction_ended", outcome, trigger: event.reason, ...(event.errorMessage === undefined ? {} : { reason: event.errorMessage }) }] };
    }
    case "thinking_level_changed":
      // pi's own report after a level change (setThinkingLevel, a model
      // switch that re-clamps): the level its next request runs.
      return { state, events: [{ kind: "effort", effort: event.level }] };
    case "auto_retry_start":
    case "summarization_retry_scheduled":
      return { state, events: [{ kind: "retry", attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, reason: event.errorMessage }] };
    case "tool_execution_end": {
      // An AgentToolResult's `content` blocks are the result; `details`
      // stays in the native frame. Any other shape is kept whole.
      const blocks = asRecord(event.result)?.content;
      const content = Array.isArray(blocks) && blocks.length > 0 ? toolContent(blocks) : toolContent(event.result);
      const result = typeof event.isError === "boolean" ? (event.isError ? "failed" as const : "ok" as const) : undefined;
      return { state, events: [{
        kind: "tool_call_ended",
        callId: event.toolCallId,
        ...(content === undefined ? {} : { content }),
        ...(result === undefined ? {} : { result }),
      }] };
    }
    case "turn_end":
      // A provider failure surfaces only as stopReason "error" on the turn's
      // final assistant message (pinned by the pi vendor 400 test).
      return event.message.role === "assistant" && event.message.stopReason === "error"
        ? { state: { ...state, providerError: { message: event.message.errorMessage ?? "provider error", overflow: extra.overflow === true } }, events: [] }
        : { state, events: [] };
    // Recorded with no event (an exhaustive switch makes a NEW pi event type a
    // compile error, forcing a conscious event-or-plain decision on each
    // future addition).
    case "message_start":
      return { state, events: event.message.role === "user" ? [{ kind: "user_message", evidence: "conversation", input: typeof event.message.content === "string" ? event.message.content : event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("") }] : [] };
    case "agent_start":
    case "agent_end":
    case "turn_start":
    case "bash_execution_update":
    case "queue_update":
    case "entry_appended":
    case "session_info_changed":
    case "auto_retry_end":
    case "summarization_retry_attempt_start":
    case "summarization_retry_finished":
      return { state, events: [] };
  }
  return { state, events: [] };
}

/** Fold one pi SDK event into the next state plus the one frame command it produces. */
export function foldPiEvent(
  state: PiProjectionState,
  event: AgentSessionEvent,
  extra: PiFoldExtra = {},
): { readonly state: PiProjectionState; readonly commands: readonly ProjectionCommand[] } {
  const next = step(state, event, extra);
  return {
    state: next.state,
    commands: [{ kind: "frame", body: { type: event.type, native: event, events: next.events } }],
  };
}
