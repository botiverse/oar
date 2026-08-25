import { classifyFailure } from "../../shared/failure-class.js";
import { asRecord, parseJson, type JsonRecord } from "../../shared/json.js";
import type { SessionKernel, KernelTurn } from "../../shared/session-kernel.js";

/**
 * The claude stream-json → SessionEvent projection, extracted from transport
 * so the live adapter and the record/replay tests drive IDENTICAL code: given
 * a kernel and a line of claude stdout, advance the event stream. The live
 * adapter owns spawning, stdin, abort, and queue drain; this owns only the
 * translation. Behavior is pinned by tests/replay against recorded fixtures.
 */

/** The projection's mutable state — a slice of the live session state. */
export interface ClaudeProjectionState {
  turn: KernelTurn | null;
  abortPending: boolean;
}

function contentBlocks(message: JsonRecord): readonly JsonRecord[] {
  const inner = asRecord(message.message);
  const content = inner?.content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.map((block) => asRecord(block)).filter((block) => block !== null);
}

function projectMessage(state: ClaudeProjectionState, message: JsonRecord): void {
  const turn = state.turn;
  if (turn === null || turn.settled()) {
    return;
  }
  switch (String(message.type)) {
    case "assistant": {
      for (const block of contentBlocks(message)) {
        switch (String(block.type)) {
          case "text": {
            if (typeof block.text === "string") {
              turn.emit({ kind: "text_delta", text: block.text });
            }
            break;
          }
          case "thinking": {
            const content = typeof block.thinking === "string" && block.thinking.length > 0
              ? { kind: "text" as const, text: block.thinking }
              : { kind: "empty" as const };
            turn.emit({ kind: "reasoning", content });
            break;
          }
          case "redacted_thinking": {
            turn.emit({ kind: "reasoning", content: { kind: "redacted" } });
            break;
          }
          case "tool_use": {
            const started = {
              kind: "tool_call_started",
              callId: typeof block.id === "string" ? block.id : "unknown",
              tool: typeof block.name === "string" ? block.name : "unknown",
            } as const;
            const input = block.input === undefined ? undefined : JSON.stringify(block.input);
            turn.emit(input === undefined ? started : { ...started, input });
            break;
          }
          default:
            break;
        }
      }
      break;
    }
    case "user": {
      for (const block of contentBlocks(message)) {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          const output = block.content === undefined ? undefined : JSON.stringify(block.content);
          turn.emit(output === undefined
            ? { kind: "tool_call_ended", callId: block.tool_use_id }
            : { kind: "tool_call_ended", callId: block.tool_use_id, output });
        }
      }
      break;
    }
    case "result": {
      settleFromResult(state, turn, message);
      break;
    }
    default:
      break;
  }
}

function settleFromResult(state: ClaudeProjectionState, turn: KernelTurn, message: JsonRecord): void {
  if (state.abortPending) {
    state.abortPending = false;
    turn.settle({ kind: "aborted" });
    return;
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
    turn.settle({ kind: "failed", reason, failure: classifyFailure(reason) });
    return;
  }
  turn.settle({ kind: "completed" });
}

/**
 * Project one line of claude stdout. Returns true when the line was a result
 * frame that left the session idle — the live adapter's cue to drain its
 * held queue (replay ignores it).
 */
export function ingestClaudeLine(
  kernel: SessionKernel,
  state: ClaudeProjectionState,
  line: string,
): boolean {
  const message = asRecord(parseJson(line));
  if (message === null) {
    return false;
  }
  // A system/init with no active turn is claude starting a run on its own
  // (a steer that landed past the turn's end) — surface it as a real turn.
  if (message.type === "system" && message.subtype === "init" && kernel.active() === null) {
    state.turn = kernel.begin();
  }
  projectMessage(state, message);
  return message.type === "result" && kernel.active() === null;
}
