/* oxlint-disable eslint/max-lines -- One ACP projection: the session updates, tool lifecycle and the events they become read together. */
import type {
  ContextUsage,
  RuntimeEventBody,
  TokenTotals,
  TurnOutcome,
} from "../../contracts/session.js";
import type { ToolOutputPart } from "../../contracts/tool-output.js";
import { asNumber, asRecord, type JsonRecord } from "../json.js";
import { addTokens } from "../token-totals.js";
import { toolContent } from "../tool-output.js";
import { AcpError } from "./errors.js";
import { acpReportedEffort, acpReportedModel } from "./model.js";
import { acpPlanEvents } from "./plan.js";

/** Vendor-specific tool result reading when closing `tool_call_update.content` is absent. */
export type AcpRawToolOutputReader = (rawOutput: unknown, status: unknown) => readonly ToolOutputPart[] | undefined;

/**
 * ACP `session/update` → events, as a pure projection. Every update becomes
 * exactly one frame (the adapter records the notification verbatim as
 * `native`); this file only decides what oar READ out of it. Unknown update
 * kinds yield no events and are still recorded.
 */

interface ToolState {
  readonly callId: string;
  ended: boolean;
  /** The input last reported for the call (`tool_call_started` or `tool_call_input`); absent while none was. */
  input: string | undefined;
}

/** Per-session tool lifecycle memory: a terminal status ends a call once; an input is reported once per change. */
export interface AcpProjectionState {
  readonly tools: Map<string, ToolState>;
}

export function createAcpProjectionState(): AcpProjectionState {
  return { tools: new Map() };
}

function textContent(value: unknown): string | null {
  const content = asRecord(value);
  if (content !== null && typeof content.text === "string") {
    return content.text;
  }
  // An ACP ToolCallContent of type "content" wraps a ContentBlock (grok's
  // completed `run_terminal_command`: `[{type: "content", content: {type:
  // "text", text}}]`); its text is the call's readable output.
  if (content !== null && content.type === "content") {
    return textContent(content.content);
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => textContent(item))
      .filter((item): item is string => item !== null);
    return parts.length === 0 ? null : parts.join("\n");
  }
  return null;
}

function truncate(value: string): string {
  return value.length > 10_000 ? `${value.slice(0, 10_000)}…` : value;
}

/** Arguments are data: preserve JSON fields and size so hosts can parse the complete input. */
function inputDetail(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function outputDetail(value: unknown): string | undefined {
  const text = textContent(value) ?? inputDetail(value);
  return text === undefined ? undefined : truncate(text);
}

function toolName(update: JsonRecord): string {
  if (typeof update.name === "string") {
    return update.name;
  }
  if (typeof update.toolName === "string") {
    return update.toolName;
  }
  // ACP opening titles name the tool; later titles can be progress text.
  if (update.sessionUpdate === "tool_call" && typeof update.title === "string") {
    return update.title;
  }
  return typeof update.kind === "string" ? update.kind : "tool";
}

function projectTool(state: AcpProjectionState, update: JsonRecord, rawToolOutput?: AcpRawToolOutputReader): RuntimeEventBody[] {
  const callId = typeof update.toolCallId === "string" ? update.toolCallId : null;
  if (callId === null) {
    return [];
  }
  const events: RuntimeEventBody[] = [];
  let tool = state.tools.get(callId);
  const terminal = update.status === "completed" || update.status === "failed" || update.status === "cancelled";
  // ACP can close a permission card with only its id and status. Without an
  // opening or tool evidence, keep the native frame but do not invent a call.
  if (tool === undefined && terminal && update.sessionUpdate === "tool_call_update"
    && ![update.name, update.toolName, update.title].some(value => typeof value === "string" && value.trim() !== "")
    && [update.rawInput, update.rawOutput].every(value => value === null || value === undefined)
    && !(Array.isArray(update.content) && update.content.length > 0)) {
    return [];
  }
  const opening = tool === undefined;
  if (tool === undefined) {
    const input = inputDetail(update.rawInput);
    tool = { callId, ended: false, input };
    state.tools.set(callId, tool);
    events.push({
      kind: "tool_call_started",
      callId,
      tool: toolName(update),
      ...(input === undefined ? {} : { input }),
    });
  } else if (!tool.ended) {
    // A runtime may send the arguments only on a later update (opencode's
    // opening `tool_call` has `rawInput` `{cwd}`, the next update `{command,
    // cwd}`; kimi's has none, and one update carries it whole). Read in the
    // started input's form, so an unchanged repeat says nothing new.
    const input = inputDetail(update.rawInput);
    if (input !== undefined && input !== tool.input) {
      tool.input = input;
      events.push({ kind: "tool_call_input", callId, input });
    }
  }
  if (!tool.ended && !terminal && !opening && update.rawOutput !== undefined) {
    // A later non-terminal update with rawOutput is streamed output. `content`
    // is NOT used here: kimi streams the call's ARGUMENTS as content while
    // in_progress (wire-shapes test), which is input, not output.
    const output = outputDetail(update.rawOutput);
    events.push({ kind: "tool_call_progress", callId, ...(output === undefined ? {} : { output }) });
  }
  if (!tool.ended && terminal) {
    tool.ended = true;
    // `content` is what the runtime wants shown (grok's bash text; kimi's
    // terminal reference); each ToolCallContent wraps its ContentBlock as
    // `{type: "content", content}`. Without content, `rawOutput` is the result.
    const unwrapped = toolContent(update.content, (item: unknown) => {
      const wrapper = asRecord(item);
      return wrapper?.type === "content" ? wrapper.content : item;
    }) ?? rawToolOutput?.(update.rawOutput, update.status) ?? toolContent(update.rawOutput);
    const content = unwrapped?.map((part) => (part.type === "text" ? { type: "text" as const, text: truncate(part.text) } : part));
    let result: "ok" | "failed" | undefined = undefined;
    if (update.status === "completed") {
      result = "ok";
    } else if (update.status === "failed") {
      result = "failed";
    }
    const exitCode = rawOutputExitCode(update.rawOutput);
    events.push({
      kind: "tool_call_ended",
      callId,
      ...(content === undefined ? {} : { content }),
      ...(result === undefined ? {} : { result }),
      ...(exitCode === undefined ? {} : { exitCode }),
    });
  }
  return events;
}

/**
 * The exit status a vendor puts on a completed command's `rawOutput` (grok
 * 1.0.25: `{type: "Bash", exit_code: 0, signal: null, …}`). ACP itself
 * defines none, so the key is read only when present; `null` is the
 * runtime's own "no code".
 */
function rawOutputExitCode(rawOutput: unknown): number | null | undefined {
  const record = asRecord(rawOutput);
  if (record === null) {
    return undefined;
  }
  const value = "exit_code" in record ? record.exit_code : record.exitCode;
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "number" ? value : null;
}

/** Context fullness from a `usage_update` (`used` / `size`), when it carries any. */
export function acpContextUsage(update: JsonRecord): ContextUsage | null {
  const tokens = asNumber(update.used);
  const contextWindow = asNumber(update.size);
  if (tokens === null && contextWindow === null) {
    return null;
  }
  const percent = tokens === null || contextWindow === null || contextWindow === 0
    ? null
    : Math.round((tokens / contextWindow) * 100);
  return { tokens, contextWindow, percent };
}

/**
 * A prompt answer's `usage` event, from the profile's readings of it: the
 * context, and the prompt's own ledger added to the session's `billed`
 * total (cache parts included) and stamped cumulative. No event when the
 * answer carried neither.
 */
export function acpPromptUsage(
  context: ContextUsage | null,
  prompted: TokenTotals | null,
  billed: TokenTotals,
): { readonly event: RuntimeEventBody | null; readonly billed: TokenTotals } {
  const next = prompted === null ? billed : addTokens(billed, prompted);
  if (context === null && prompted === null) {
    return { event: null, billed: next };
  }
  return { event: { kind: "usage", usage: { ...(context === null ? {} : { context }), ...(prompted === null ? {} : { tokens: next }) } }, billed: next };
}

function reasoningView(value: unknown): RuntimeEventBody {
  const text = textContent(value);
  return {
    kind: "reasoning",
    content: text === null
      ? { kind: "redacted" }
      : (text.length === 0
        ? { kind: "empty" }
        : { kind: "text", text }),
  };
}

/** The events oar reads out of one `session/update`; the update itself is recorded verbatim by the caller. */
export function projectAcpUpdate(state: AcpProjectionState, update: JsonRecord, rawToolOutput?: AcpRawToolOutputReader): RuntimeEventBody[] {
  const events: RuntimeEventBody[] = [];
  switch (update.sessionUpdate) {
    case "usage_update": {
      const context = acpContextUsage(update);
      if (context !== null) {
        events.push({ kind: "usage", usage: { context } });
      }
      break;
    }
    case "agent_message_chunk": {
      const text = textContent(update.content);
      if (text !== null && text.length > 0) {
        events.push({ kind: "text_delta", text });
      }
      break;
    }
    case "agent_thought_chunk":
      events.push(reasoningView(update.content));
      break;
    case "tool_call":
    case "tool_call_update":
      events.push(...projectTool(state, update, rawToolOutput));
      break;
    case "plan":
      // The agent's whole checklist replaces the previous one; an empty list is its own clear.
      events.push(...acpPlanEvents(update));
      break;
    default:
      break;
  }
  // Any frame that names the effective model (kimi's config_option_update,
  // grok's `_meta.model`) is also a model report; one whose `thought_level`
  // option names a current value (a `config_option_update`) is an effort one.
  const model = acpReportedModel(update);
  if (model !== null) {
    events.push({ kind: "model", model });
  }
  const effort = acpReportedEffort(update);
  if (effort !== null) {
    events.push({ kind: "effort", effort });
  }
  return events;
}

/** The outcome an ACP prompt answer reports: `cancelled` is the runtime honoring session/cancel. */
export function defaultAcpPromptOutcome(response: JsonRecord): TurnOutcome {
  if (response.stopReason === "cancelled") { return { kind: "aborted" }; }
  // [schema] ACP StopReason "refusal" indicates the model declined to answer.
  if (response.stopReason === "refusal") { return { kind: "failed", failure: "model_refused", reason: "refusal" }; }
  return { kind: "completed" };
}

export { acpFailureOutcome } from "./failure.js";

/** A JSON-safe rendering of an RPC error for the `native` of a prompt-error event. */
export function acpErrorNative(error: unknown): JsonRecord {
  if (error instanceof AcpError) {
    return { name: error.name, kind: error.kind, message: error.message, exitCode: error.exitCode, method: error.method, timeoutMs: error.timeoutMs };
  }
  if (error instanceof Error) {
    const extra = asRecord(error) ?? {};
    return { ...extra, name: error.name, message: error.message };
  }
  return { message: String(error) };
}
