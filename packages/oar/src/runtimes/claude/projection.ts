import type { SessionEventBody, TurnOutcome } from "../../contracts/session.js";
import { classifyFailure } from "../../shared/failure-class.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";

/**
 * The claude stdout → SessionEvent projection as a PURE FOLD. It is the same
 * family as observe/reduceStatus, one layer earlier: a reducer over the raw
 * provider stream that emits kernel COMMANDS (begin a turn, emit an event,
 * settle an outcome) instead of touching the kernel itself. The live adapter
 * applies the commands to a real kernel; tests apply them to nothing and
 * snapshot the list. No transport, no side effects — so it is trivially
 * unit-testable and shared verbatim between live and replay.
 *
 * Not generic: each runtime speaks a different wire vocabulary, so each has
 * its own fold. What IS shared is the OUTPUT — SessionEventBody and this
 * command algebra.
 */

export type ProjectionCommand =
  | { readonly kind: "begin" }
  | { readonly kind: "emit"; readonly body: SessionEventBody }
  | { readonly kind: "settle"; readonly outcome: TurnOutcome };

/**
 * Fold state. `inTurn` is the projection's own view of turn framing (set true
 * by the control plane on prompt, by the fold on a spontaneous init).
 * `abortRequested` is the one input that is NOT in the provider stream — abort
 * is a control-plane intent, and claude reports its result as an ordinary
 * result frame, so the flag is how the fold tells aborted from completed. It
 * makes explicit that projection folds over provider events ⊎ control intent.
 */
export interface ClaudeProjectionState {
  readonly inTurn: boolean;
  readonly abortRequested: boolean;
}

export const initialClaudeProjection: ClaudeProjectionState = { inTurn: false, abortRequested: false };

/** Control plane → state: a prompt opens a turn; an abort arms the flag. */
export function claudePrompted(): ClaudeProjectionState {
  return { inTurn: true, abortRequested: false };
}

export function claudeAbortRequested(state: ClaudeProjectionState): ClaudeProjectionState {
  return { ...state, abortRequested: true };
}

function contentBlocks(message: JsonRecord): readonly JsonRecord[] {
  const inner = asRecord(message.message);
  const content = inner?.content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.map((block) => asRecord(block)).filter((block) => block !== null);
}

function assistantEvents(message: JsonRecord): SessionEventBody[] {
  const out: SessionEventBody[] = [];
  for (const block of contentBlocks(message)) {
    switch (String(block.type)) {
      case "text": {
        if (typeof block.text === "string") {
          out.push({ kind: "text_delta", text: block.text });
        }
        break;
      }
      case "thinking": {
        const content = typeof block.thinking === "string" && block.thinking.length > 0
          ? { kind: "text" as const, text: block.thinking }
          : { kind: "empty" as const };
        out.push({ kind: "reasoning", content });
        break;
      }
      case "redacted_thinking": {
        out.push({ kind: "reasoning", content: { kind: "redacted" } });
        break;
      }
      case "tool_use": {
        const started = {
          kind: "tool_call_started" as const,
          callId: typeof block.id === "string" ? block.id : "unknown",
          tool: typeof block.name === "string" ? block.name : "unknown",
        };
        const input = block.input === undefined ? undefined : JSON.stringify(block.input);
        out.push(input === undefined ? started : { ...started, input });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function toolResultEvents(message: JsonRecord): SessionEventBody[] {
  const out: SessionEventBody[] = [];
  for (const block of contentBlocks(message)) {
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      const output = block.content === undefined ? undefined : JSON.stringify(block.content);
      out.push(output === undefined
        ? { kind: "tool_call_ended", callId: block.tool_use_id }
        : { kind: "tool_call_ended", callId: block.tool_use_id, output });
    }
  }
  return out;
}

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
    const reason = text ?? subtype ?? "error";
    return { kind: "failed", reason, failure: classifyFailure(reason) };
  }
  return { kind: "completed" };
}

/** Fold one parsed claude stdout frame into the next state plus commands. */
export function foldClaudeStdout(
  state: ClaudeProjectionState,
  message: JsonRecord,
): { readonly state: ClaudeProjectionState; readonly commands: readonly ProjectionCommand[] } {
  // A system/init with no active turn is claude starting a run on its own (a
  // steer that landed past the turn's end) — a spontaneous turn.
  if (message.type === "system" && message.subtype === "init" && !state.inTurn) {
    return { state: { ...state, inTurn: true }, commands: [{ kind: "begin" }] };
  }
  if (!state.inTurn) {
    return { state, commands: [] };
  }
  switch (String(message.type)) {
    case "assistant":
      return { state, commands: assistantEvents(message).map((body) => ({ kind: "emit", body })) };
    case "user":
      return { state, commands: toolResultEvents(message).map((body) => ({ kind: "emit", body })) };
    case "result":
      return {
        state: { inTurn: false, abortRequested: false },
        commands: [{ kind: "settle", outcome: resultOutcome(state, message) }],
      };
    default:
      return { state, commands: [] };
  }
}
