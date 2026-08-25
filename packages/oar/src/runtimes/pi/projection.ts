import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SessionEventBody, TurnOutcome } from "../../contracts/session.js";
import { classifyFailure } from "../../shared/failure-class.js";

/**
 * The pi SDK-event → SessionEvent projection as a PURE FOLD (see
 * runtimes/claude/projection.ts). Emits kernel commands (begin/emit/settle).
 * pi is the most stateful of the three: a turn may be `adopted` (a run pi
 * started that we did not prompt — settled here on agent_end) or prompt-
 * initiated (settled by the adapter's prompt promise, which reads this same
 * state via piSettledOutcome). abortRequested / providerError are control-
 * plane and error inputs the provider stream alone does not carry.
 */

export type ProjectionCommand =
  | { readonly kind: "begin" }
  | { readonly kind: "emit"; readonly body: SessionEventBody }
  | { readonly kind: "settle"; readonly outcome: TurnOutcome };

export interface PiProjectionState {
  readonly inTurn: boolean;
  readonly adopted: boolean;
  readonly abortRequested: boolean;
  readonly reasoningHadText: boolean;
  readonly providerError: string | undefined;
}

export const initialPiProjection: PiProjectionState = {
  inTurn: false,
  adopted: false,
  abortRequested: false,
  reasoningHadText: false,
  providerError: undefined,
};

/** Control plane → state: a prompt opens a non-adopted turn, resetting per-turn accumulators. */
export function piPrompted(): PiProjectionState {
  return { ...initialPiProjection, inTurn: true };
}

export function piAbortRequested(state: PiProjectionState): PiProjectionState {
  return { ...state, abortRequested: true };
}

/** The outcome for a prompt-initiated turn (the fold settles adopted turns itself). */
export function piSettledOutcome(state: PiProjectionState): TurnOutcome {
  if (state.abortRequested) {
    return { kind: "aborted" };
  }
  if (state.providerError !== undefined) {
    return { kind: "failed", reason: state.providerError, failure: classifyFailure(state.providerError) };
  }
  return { kind: "completed" };
}

const drop = (state: PiProjectionState): { state: PiProjectionState; commands: readonly ProjectionCommand[] } =>
  ({ state, commands: [] });

const emit = (state: PiProjectionState, body: SessionEventBody): { state: PiProjectionState; commands: readonly ProjectionCommand[] } =>
  ({ state, commands: [{ kind: "emit", body }] });

function foldMessageUpdate(
  state: PiProjectionState,
  inner: Extract<AgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"],
): { state: PiProjectionState; commands: readonly ProjectionCommand[] } {
  switch (inner.type) {
    case "text_delta":
      return emit(state, { kind: "text_delta", text: inner.delta });
    case "thinking_delta":
      return inner.delta.length > 0
        ? emit({ ...state, reasoningHadText: true }, { kind: "reasoning", content: { kind: "text", text: inner.delta } })
        : drop(state);
    case "error":
      // pi's prompt() RESOLVES even when the provider errored — the failure
      // only surfaces here (pinned by the pi vendor 400 test).
      return drop({ ...state, providerError: inner.error.errorMessage ?? inner.reason });
    case "thinking_start":
      return drop({ ...state, reasoningHadText: false });
    case "thinking_end":
      return state.reasoningHadText ? drop(state) : emit(state, { kind: "reasoning", content: { kind: "empty" } });
    // Explicitly dropped: block boundaries and toolcall framing carry no v1
    // turn event (toolcalls arrive via the outer tool_execution_* events).
    case "start":
    case "done":
    case "text_start":
    case "text_end":
    case "toolcall_start":
    case "toolcall_delta":
    case "toolcall_end":
      return drop(state);
  }
  return drop(state);
}

/** Fold one pi SDK event into the next state plus commands. */
export function foldPiEvent(
  state: PiProjectionState,
  event: AgentSessionEvent,
): { readonly state: PiProjectionState; readonly commands: readonly ProjectionCommand[] } {
  if (event.type === "agent_start") {
    // A run pi starts that we did not prompt (a drained followUp) becomes an
    // adopted turn, settled here on agent_end.
    return state.inTurn
      ? drop(state)
      : { state: { ...piPrompted(), adopted: true }, commands: [{ kind: "begin" }] };
  }
  if (!state.inTurn) {
    return drop(state);
  }
  switch (event.type) {
    case "agent_end":
      // Adopted turns settle here; prompt-initiated turns are settled by the
      // adapter's prompt promise (which reads piSettledOutcome).
      return state.adopted
        ? { state: initialPiProjection, commands: [{ kind: "settle", outcome: piSettledOutcome(state) }] }
        : { state: { ...state, inTurn: false }, commands: [] };
    case "message_update":
      return foldMessageUpdate(state, event.assistantMessageEvent);
    case "tool_execution_start":
      return emit(state, { kind: "tool_call_started", callId: event.toolCallId, tool: event.toolName });
    case "tool_execution_end":
      return emit(state, { kind: "tool_call_ended", callId: event.toolCallId });
    case "turn_end":
      // A provider failure surfaces only as stopReason "error" on the turn's
      // final assistant message (pinned by the pi vendor 400 test).
      return event.message.role === "assistant" && event.message.stopReason === "error"
        ? drop({ ...state, providerError: event.message.errorMessage ?? "provider error" })
        : drop(state);
    // Explicitly dropped: session-scoped events with no turn mapping in v1 (an
    // exhaustive switch makes a NEW pi event type a compile error, forcing a
    // conscious mapped-or-dropped decision on each future addition).
    case "agent_settled":
    case "turn_start":
    case "message_start":
    case "message_end":
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
      return drop(state);
  }
  return drop(state);
}
