import type {
  ContextUsage,
  EventView,
  TurnOutcome,
} from "../../contracts/session.js";
import { classifyFailure } from "../failure-class.js";
import { asNumber, asRecord, type JsonRecord } from "../json.js";
import { AcpError } from "./errors.js";
import { acpReportedModel } from "./model.js";

/**
 * ACP `session/update` → views, as a pure projection. Every update becomes
 * exactly one event record (the adapter records the notification verbatim as
 * `native`); this file only decides what oar READ out of it. Unknown update
 * kinds yield no views and are still recorded.
 */

interface ToolState {
  readonly callId: string;
  ended: boolean;
}

/** Per-session tool lifecycle memory: a terminal status ends a call once. */
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

function detail(value: unknown): string | undefined {
  if (typeof value === "string") {
    return truncate(value);
  }
  if (value === undefined || value === null) {
    return undefined;
  }
  const text = textContent(value);
  if (text !== null) {
    return truncate(text);
  }
  try {
    return truncate(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function toolName(update: JsonRecord): string {
  if (typeof update.name === "string") {
    return update.name;
  }
  if (typeof update.toolName === "string") {
    return update.toolName;
  }
  // ACP's `kind` is a category (execute, other, …), never a tool's name; the
  // OPENING `tool_call` frame's `title` is the closest thing the protocol has
  // (kimi 0.42.0: title "Bash"/"Agent" with kind "execute"/"other" for the
  // two tools observed; grok: title "run_terminal_command" and no kind). A
  // later `tool_call_update` retitles the call with progress text ("Running:
  // …", kimi seq 25), so a call first seen on an update falls back to `kind`.
  if (update.sessionUpdate === "tool_call" && typeof update.title === "string") {
    return update.title;
  }
  return typeof update.kind === "string" ? update.kind : "tool";
}

function projectTool(state: AcpProjectionState, update: JsonRecord): EventView[] {
  const callId = typeof update.toolCallId === "string" ? update.toolCallId : null;
  if (callId === null) {
    return [];
  }
  const views: EventView[] = [];
  let tool = state.tools.get(callId);
  if (tool === undefined) {
    tool = { callId, ended: false };
    state.tools.set(callId, tool);
    const input = detail(update.rawInput);
    views.push({
      kind: "tool_call_started",
      callId,
      tool: toolName(update),
      ...(input === undefined ? {} : { input }),
    });
  }
  const terminal = update.status === "completed"
    || update.status === "failed"
    || update.status === "cancelled";
  if (!tool.ended && terminal) {
    tool.ended = true;
    const output = detail(update.rawOutput) ?? detail(update.content);
    views.push({
      kind: "tool_call_ended",
      callId,
      ...(output === undefined ? {} : { output }),
    });
  }
  return views;
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

function reasoningView(value: unknown): EventView {
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

/** The views oar reads out of one `session/update`; the update itself is recorded verbatim by the caller. */
export function projectAcpUpdate(state: AcpProjectionState, update: JsonRecord): EventView[] {
  const views: EventView[] = [];
  switch (update.sessionUpdate) {
    case "usage_update": {
      const context = acpContextUsage(update);
      if (context !== null) {
        views.push({ kind: "usage", usage: { context } });
      }
      break;
    }
    case "agent_message_chunk": {
      const text = textContent(update.content);
      if (text !== null && text.length > 0) {
        views.push({ kind: "text_delta", text });
      }
      break;
    }
    case "agent_thought_chunk":
      views.push(reasoningView(update.content));
      break;
    case "tool_call":
    case "tool_call_update":
      views.push(...projectTool(state, update));
      break;
    default:
      break;
  }
  // Any frame that names the effective model (kimi's config_option_update,
  // grok's `_meta.model`) is also a model report.
  const model = acpReportedModel(update);
  if (model !== null) {
    views.push({ kind: "model", model });
  }
  return views;
}

/** The outcome an ACP prompt answer reports: `cancelled` is the runtime honoring session/cancel. */
export function defaultAcpPromptOutcome(response: JsonRecord): TurnOutcome {
  return response.stopReason === "cancelled"
    ? { kind: "aborted" }
    : { kind: "completed" };
}

/** The outcome a rejected prompt request reports (an RPC error answer). */
export function acpFailureOutcome(error: unknown): TurnOutcome {
  const reason = error instanceof Error ? error.message : "ACP prompt failed";
  return {
    kind: "failed",
    reason,
    failure: error instanceof AcpError && error.kind === "process_exited"
      ? "runtime_exited"
      : classifyFailure(reason),
  };
}

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
