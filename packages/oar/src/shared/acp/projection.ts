import type {
  ContextUsage,
  SessionEventBody,
  TurnOutcome,
} from "../../contracts/session.js";
import { classifyFailure } from "../failure-class.js";
import { asNumber, asRecord, type JsonRecord } from "../json.js";
import { AcpError } from "./errors.js";

interface ToolState {
  readonly callId: string;
  ended: boolean;
}

export interface AcpProjectionState {
  readonly tools: Map<string, ToolState>;
}

export interface AcpProjectionResult {
  readonly bodies: readonly SessionEventBody[];
  readonly contextUsage?: ContextUsage;
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
  if (typeof update.toolName === "string") {
    return update.toolName;
  }
  if (typeof update.kind === "string") {
    return update.kind;
  }
  return typeof update.title === "string" ? update.title : "tool";
}

function projectTool(state: AcpProjectionState, update: JsonRecord): SessionEventBody[] {
  const callId = typeof update.toolCallId === "string" ? update.toolCallId : null;
  if (callId === null) {
    return [];
  }
  const bodies: SessionEventBody[] = [];
  let tool = state.tools.get(callId);
  if (tool === undefined) {
    tool = { callId, ended: false };
    state.tools.set(callId, tool);
    const input = detail(update.rawInput);
    bodies.push({
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
    bodies.push({
      kind: "tool_call_ended",
      callId,
      ...(output === undefined ? {} : { output }),
    });
  }
  return bodies;
}

function usageFromUpdate(update: JsonRecord): ContextUsage | null {
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

function reasoningBody(value: unknown): SessionEventBody {
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

export function projectAcpUpdate(
  state: AcpProjectionState,
  update: JsonRecord,
): AcpProjectionResult {
  switch (update.sessionUpdate) {
    case "usage_update": {
      const contextUsage = usageFromUpdate(update);
      return contextUsage === null ? { bodies: [] } : { bodies: [], contextUsage };
    }
    case "agent_message_chunk": {
      const text = textContent(update.content);
      return text === null || text.length === 0
        ? { bodies: [] }
        : { bodies: [{ kind: "text_delta", text }] };
    }
    case "agent_thought_chunk":
      return { bodies: [reasoningBody(update.content)] };
    case "tool_call":
    case "tool_call_update":
      return { bodies: projectTool(state, update) };
    default:
      return { bodies: [] };
  }
}

export function finishAcpTools(state: AcpProjectionState): SessionEventBody[] {
  const bodies: SessionEventBody[] = [];
  for (const tool of state.tools.values()) {
    if (!tool.ended) {
      tool.ended = true;
      bodies.push({ kind: "tool_call_ended", callId: tool.callId });
    }
  }
  return bodies;
}

export function defaultAcpPromptOutcome(response: JsonRecord): TurnOutcome {
  return response.stopReason === "cancelled"
    ? { kind: "aborted" }
    : { kind: "completed" };
}

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

export function acpRuntimeExitedOutcome(code: number | null): TurnOutcome {
  return {
    kind: "failed",
    reason: code === null ? "ACP process exited" : `ACP process exited with code ${code}`,
    failure: "runtime_exited",
  };
}
