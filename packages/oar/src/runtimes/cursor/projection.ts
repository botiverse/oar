import type { RuntimeEventBody, TokenTotals, ToolOutputPart, TurnOutcome } from "../../contracts/session.js";
import { classifyFailure } from "../../shared/failure-class.js";
import { asNumber, asRecord, type JsonRecord } from "../../shared/json.js";
import { toolContent } from "../../shared/tool-output.js";
import { cursorSelectionEffort } from "./model.js";
import type { ModelSelection } from "./sdk.js";

/*
 * `@cursor/sdk` 1.0.35 reports a run through `send(…, { onDelta })`: one
 * update per call, each a record with a `type` (`text-delta`,
 * `thinking-delta`, `tool-call-started`, `tool-call-completed`,
 * `user-message-appended`, `turn-ended` with the turn's token usage, and
 * bookkeeping kinds OAR reads nothing from: `token-delta`,
 * `thinking-completed`, `partial-tool-call`, `tool-requests-listed`,
 * `step-started`, `step-completed`, `shell-output-delta`). Every update is
 * one frame. The SDK drops its `summary*` updates before `onDelta`, so
 * compaction is not observable. The run's end is not an update: `run.wait()`
 * answers with the run's status, recorded as its own frame.
 */

/** `tokens`: cumulative per agent path, so usage events stay summable. */
export interface CursorProjectionState {
  readonly tokens: ReadonlyMap<string, TokenTotals>;
}

export const initialCursorProjection: CursorProjectionState = { tokens: new Map() };

export interface CursorFrame {
  readonly type: string;
  readonly native: unknown;
  readonly events: readonly RuntimeEventBody[];
  /** The sub-agent a subagent's update came from: the `task` call ids, outermost first. */
  readonly agentPath: readonly string[];
}

/**
 * A subagent speaks through its `task` call: `tool-call-delta` carries the
 * child's own update under `taskUpdate`, keyed by the call id (probed
 * 2026-10-03: the child's thinking, tool calls and text all arrive this way).
 * SDK 1.0.35's schema allows no `tool-call-delta` inside a `taskUpdate`; if
 * one ever came, it is unwrapped the same way, one call id deeper.
 */
function innermost(update: JsonRecord, path: readonly string[]): { readonly update: JsonRecord; readonly path: readonly string[] } {
  const nested = asRecord(update.taskUpdate);
  if (update.type === "tool-call-delta" && typeof update.callId === "string" && nested !== null) {
    return innermost(nested, [...path, update.callId]);
  }
  return { update, path };
}

const pathKey = (path: readonly string[]): string => path.join("/");

const text = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

/**
 * A tool result as content parts. Shell output is its stdout and stderr, a
 * read is the file text, an edit is its diff, a failure is its message;
 * every other result is kept whole as one `other` part.
 */
export function cursorToolContent(tool: string, result: JsonRecord | null): readonly ToolOutputPart[] | undefined {
  if (result === null) {
    return undefined;
  }
  if (result.status === "error") {
    const message = text(asRecord(result.error)?.message) ?? text(result.error);
    return message === undefined ? toolContent(result.error) : [{ type: "text", text: message }];
  }
  const value = asRecord(result.value);
  const parts: ToolOutputPart[] = [];
  const add = (part: unknown): void => {
    const found = text(part);
    if (found !== undefined) {
      parts.push({ type: "text", text: found });
    }
  };
  switch (tool) {
    case "shell":
      add(value?.stdout);
      add(value?.stderr);
      // The command ran and printed nothing: a result, with empty text.
      return parts.length === 0 ? [{ type: "text", text: "" }] : parts;
    case "read":
      add(value?.content);
      break;
    case "edit":
    case "write":
      add(value?.diffString);
      break;
    default:
      break;
  }
  return parts.length > 0 ? parts : toolContent(result.value);
}

function toolOutcome(status: unknown): "ok" | "failed" | undefined {
  if (status === "success") {
    return "ok";
  }
  return status === "error" ? "failed" : undefined;
}

/** A shell's exit code, or `null` when cursor names the signal that ended it. */
function shellExit(tool: string, result: JsonRecord | null): { readonly exitCode?: number | null } {
  const value = tool === "shell" && result?.status === "success" ? asRecord(result.value) : null;
  if (value === null) {
    return {};
  }
  if (typeof value.signal === "string" && value.signal !== "") {
    return { exitCode: null };
  }
  const exitCode = asNumber(value.exitCode);
  return exitCode === null ? {} : { exitCode };
}

function toolEnded(update: JsonRecord): RuntimeEventBody | null {
  const callId = text(update.callId);
  if (callId === undefined) {
    return null;
  }
  const call = asRecord(update.toolCall);
  const tool = text(call?.type) ?? "unknown";
  const result = asRecord(call?.result);
  const content = cursorToolContent(tool, result);
  const outcome = toolOutcome(result?.status);
  return {
    kind: "tool_call_ended",
    callId,
    ...(content === undefined ? {} : { content }),
    ...(outcome === undefined ? {} : { result: outcome }),
    ...shellExit(tool, result),
  };
}

function eventsOf(
  state: CursorProjectionState,
  update: JsonRecord,
  path: readonly string[],
): { readonly state: CursorProjectionState; readonly events: readonly RuntimeEventBody[] } {
  switch (update.type) {
    case "text-delta": {
      const delta = text(update.text);
      return { state, events: delta === undefined ? [] : [{ kind: "text_delta", text: delta }] };
    }
    case "thinking-delta": {
      const delta = text(update.text);
      return { state, events: delta === undefined ? [] : [{ kind: "reasoning", content: { kind: "text", text: delta } }] };
    }
    case "tool-call-started": {
      const callId = text(update.callId);
      const call = asRecord(update.toolCall);
      if (callId === undefined) {
        return { state, events: [] };
      }
      const started = { kind: "tool_call_started" as const, callId, tool: text(call?.type) ?? "unknown" };
      return { state, events: [call?.args === undefined ? started : { ...started, input: JSON.stringify(call.args) }] };
    }
    case "tool-call-completed": {
      const ended = toolEnded(update);
      return { state, events: ended === null ? [] : [ended] };
    }
    case "user-message-appended": {
      // A user message entered the conversation (a delivered steer, probed):
      // text only, so no input id is claimed (docs/spec/conversation.md).
      const input = asRecord(update.userMessage)?.text;
      return { state, events: typeof input === "string" ? [{ kind: "user_message", input, evidence: "conversation" }] : [] };
    }
    case "turn-ended": {
      const usage = asRecord(update.usage);
      if (usage === null) {
        return { state, events: [] };
      }
      const previous = state.tokens.get(pathKey(path)) ?? { input: 0, output: 0 };
      // `inputTokens` excludes cache reads and writes (totalTokens is the sum
      // of all four), so input counts them back in, as claude's and pi's do.
      const tokens: TokenTotals = {
        input: previous.input + (asNumber(usage.inputTokens) ?? 0) + (asNumber(usage.cacheReadTokens) ?? 0) + (asNumber(usage.cacheWriteTokens) ?? 0),
        output: previous.output + (asNumber(usage.outputTokens) ?? 0),
      };
      return { state: { tokens: new Map([...state.tokens, [pathKey(path), tokens]]) }, events: [{ kind: "usage", usage: { tokens } }] };
    }
    default:
      return { state, events: [] };
  }
}

/** One `onDelta` update as one frame, attributed to the subagent it came from. */
export function foldCursorDelta(state: CursorProjectionState, native: unknown): { readonly state: CursorProjectionState; readonly frame: CursorFrame } {
  const outer = asRecord(native) ?? {};
  const { update, path } = innermost(outer, []);
  const read = eventsOf(state, update, path);
  return { state: read.state, frame: { type: text(outer.type) ?? "unknown", native, events: read.events, agentPath: path } };
}

function selectionEvents(selection: ModelSelection | undefined): RuntimeEventBody[] {
  if (selection === undefined) {
    return [];
  }
  const effort = cursorSelectionEffort(selection);
  return [{ kind: "model", model: selection.id }, ...(effort === null ? [] : [{ kind: "effort" as const, effort }])];
}

/**
 * The agent as the SDK holds it after open: its id and model selection (the
 * SDK has resolved an alias to the catalog id, `composer` → `composer-2.5`).
 */
export function cursorOpenedFrame(agentId: string, model: ModelSelection | undefined): CursorFrame {
  return { type: "cursor/agent_opened", native: { agentId, model }, events: selectionEvents(model), agentPath: [] };
}

/**
 * `run.wait()`'s answer: the run's status is the turn's outcome (`finished`,
 * `cancelled`, `error` with the SDK's message), and its `model` is what the
 * SDK records the run ran with.
 */
export function cursorRunResultFrame(result: unknown): CursorFrame {
  const record = asRecord(result) ?? {};
  const model = asRecord(record.model);
  const selection = typeof model?.id === "string"
    ? {
        id: model.id,
        params: (Array.isArray(model.params) ? model.params : []).flatMap((param: unknown) => {
          const entry = asRecord(param);
          return typeof entry?.id === "string" && typeof entry.value === "string" ? [{ id: entry.id, value: entry.value }] : [];
        }),
      }
    : undefined;
  return { type: "cursor/run_result", native: result, events: [...selectionEvents(selection), { kind: "turn_ended", outcome: runOutcome(record) }], agentPath: [] };
}

function runOutcome(result: JsonRecord): TurnOutcome {
  switch (result.status) {
    case "finished":
      return { kind: "completed" };
    case "cancelled":
      return { kind: "aborted" };
    default: {
      const reason = text(asRecord(result.error)?.message) ?? `cursor run ended with status ${String(result.status)}`;
      return { kind: "failed", reason, failure: classifyFailure(reason) };
    }
  }
}

/** `run.wait()` rejected instead of answering: the SDK's own message ends the turn. */
export function cursorRunFailedFrame(message: string): CursorFrame {
  return {
    type: "cursor/run_failed",
    native: { message },
    events: [{ kind: "turn_ended", outcome: { kind: "failed", reason: message, failure: classifyFailure(message) } }],
    agentPath: [],
  };
}
