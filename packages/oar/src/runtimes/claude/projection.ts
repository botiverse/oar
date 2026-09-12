import type {
  EventBody,
  EventView,
  ResponseBody,
  TokenTotals,
  TurnOutcome,
} from "../../contracts/session.js";
import { classifyFailure } from "../../shared/failure-class.js";
import { asNumber, asRecord, type JsonRecord } from "../../shared/json.js";
import { claudeContextUsageFromResult } from "./context-usage.js";

/**
 * The claude stdout → record projection as a PURE FOLD. A reducer over the
 * raw stream-json frames that emits kernel COMMANDS (append an event with its
 * attribution, answer one of our control requests, surface a runtime→app
 * request) instead of touching the kernel itself. The live adapter applies
 * the commands to a real kernel; tests apply them to nothing and snapshot the
 * list. No transport, no side effects, so it is trivially unit-testable and
 * shared verbatim between live and replay.
 *
 * Rules the fold enforces: EVERY frame becomes exactly one event record
 * (verbatim `native`, views in block order); nothing is gated on whether a
 * turn is "open"; the turn's end is claude's own `result` frame; attribution
 * comes from `parent_tool_use_id` (a child's path is its parent's path plus
 * the Task tool_use id that spawned it).
 */

export type ProjectionCommand =
  | { readonly kind: "event"; readonly body: EventBody; readonly agentPath: readonly string[] }
  /** claude answered one of our `control_request`s (interrupt): the response to that request record. */
  | { readonly kind: "respond"; readonly requestId: string; readonly body: ResponseBody }
  /** claude asked US something (`control_request`): a toApp request record, verbatim. */
  | { readonly kind: "toApp"; readonly id: string; readonly type: string; readonly native: unknown };

/**
 * Fold state. `abortRequested` is the one input that is NOT in the provider
 * stream: abort is a control-plane intent, and claude reports its result as
 * an ordinary result frame, so the flag is how the fold tells aborted from
 * completed. `agents` maps every tool_use id seen to the agentPath of the
 * message that carried it, so a frame with `parent_tool_use_id` attributes to
 * that tool call's agent plus the call; nested Task calls nest the path.
 * `tokens` accumulates per-agent result usage so usage views are cumulative.
 */
export interface ClaudeProjectionState {
  readonly abortRequested: boolean;
  readonly agents: ReadonlyMap<string, readonly string[]>;
  readonly tokens: ReadonlyMap<string, TokenTotals>;
}

export const initialClaudeProjection: ClaudeProjectionState = {
  abortRequested: false,
  agents: new Map(),
  tokens: new Map(),
};

/** Control plane → state: a prompt clears any stale abort intent; an abort arms it. */
export function claudePrompted(state: ClaudeProjectionState): ClaudeProjectionState {
  return { ...state, abortRequested: false };
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

function assistantViews(message: JsonRecord): EventView[] {
  const out: EventView[] = [];
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

function toolResultViews(message: JsonRecord): EventView[] {
  const out: EventView[] = [];
  for (const block of contentBlocks(message)) {
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      const output = block.content === undefined ? undefined : JSON.stringify(block.content);
      const result = typeof block.is_error === "boolean" ? (block.is_error ? "failed" as const : "ok" as const) : undefined;
      out.push(output === undefined
        ? { kind: "tool_call_ended", callId: block.tool_use_id, ...(result === undefined ? {} : { result }) }
        : { kind: "tool_call_ended", callId: block.tool_use_id, output, ...(result === undefined ? {} : { result }) });
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

function pathKey(agentPath: readonly string[]): string {
  return JSON.stringify(agentPath);
}

/** The agent a frame belongs to: root, or the Task call that spawned it (nested through the call's own agent). */
function attributionOf(state: ClaudeProjectionState, message: JsonRecord): readonly string[] {
  const parent = message.parent_tool_use_id;
  if (typeof parent !== "string" || parent.length === 0) {
    return [];
  }
  return [...(state.agents.get(parent) ?? []), parent];
}

function rememberToolUses(state: ClaudeProjectionState, message: JsonRecord, agentPath: readonly string[]): ClaudeProjectionState {
  const ids = contentBlocks(message)
    .filter((block) => block.type === "tool_use" && typeof block.id === "string")
    .map((block) => String(block.id));
  if (ids.length === 0) {
    return state;
  }
  const agents = new Map(state.agents);
  for (const id of ids) {
    agents.set(id, agentPath);
  }
  return { ...state, agents };
}

function frameType(message: JsonRecord): string {
  const type = typeof message.type === "string" ? message.type : "unknown";
  return typeof message.subtype === "string" ? `${type}/${message.subtype}` : type;
}

/** Cumulative per-agent tokens after folding this result frame's own turn usage. */
function accumulate(state: ClaudeProjectionState, agentPath: readonly string[], message: JsonRecord): { state: ClaudeProjectionState; tokens: TokenTotals } | null {
  const usage = asRecord(message.usage);
  if (usage === null) {
    return null;
  }
  const previous = state.tokens.get(pathKey(agentPath)) ?? { input: 0, output: 0 };
  const tokens: TokenTotals = {
    input: previous.input + (asNumber(usage.input_tokens) ?? 0)
      + (asNumber(usage.cache_read_input_tokens) ?? 0) + (asNumber(usage.cache_creation_input_tokens) ?? 0),
    output: previous.output + (asNumber(usage.output_tokens) ?? 0),
  };
  const next = new Map([...state.tokens, [pathKey(agentPath), tokens]]);
  return { state: { ...state, tokens: next }, tokens };
}

/** Fold one parsed claude stdout frame into the next state plus commands. */
export function foldClaudeStdout(
  state: ClaudeProjectionState,
  message: JsonRecord,
): { readonly state: ClaudeProjectionState; readonly commands: readonly ProjectionCommand[] } {
  const type = frameType(message);
  const agentPath = attributionOf(state, message);
  const event = (body: Omit<EventBody, "type" | "native">, next: ClaudeProjectionState = state): { state: ClaudeProjectionState; commands: ProjectionCommand[] } =>
    ({ state: next, commands: [{ kind: "event", body: { type, native: message, ...body }, agentPath }] });

  switch (String(message.type)) {
    case "assistant":
      return event({ views: assistantViews(message) }, rememberToolUses(state, message, agentPath));
    case "user":
      return event({ views: toolResultViews(message) });
    case "result": {
      const views: EventView[] = [{ kind: "turn_ended", outcome: resultOutcome(state, message) }];
      const accumulated = accumulate(state, agentPath, message);
      const context = claudeContextUsageFromResult(message);
      if (accumulated !== null || context !== null) {
        views.push({ kind: "usage", usage: {
          ...(context === null ? {} : { context }),
          ...(accumulated === null ? {} : { tokens: accumulated.tokens }),
        } });
      }
      return event({ views }, { ...(accumulated?.state ?? state), abortRequested: false });
    }
    case "system": {
      const model = message.subtype === "init" && typeof message.model === "string" ? message.model : null;
      return event({ views: model === null ? [] : [{ kind: "model", model }] });
    }
    case "control_response": {
      // claude answering one of OUR control_requests (interrupt): the frame IS
      // the response record (native verbatim); one frame, one record, so it
      // is not also recorded as an event. A control_response we cannot pair
      // is recorded as a plain event.
      const response = asRecord(message.response);
      const requestId = typeof response?.request_id === "string" ? response.request_id : null;
      if (requestId === null) {
        return event({ views: [] });
      }
      const error = typeof response?.error === "string" ? response.error : null;
      return { state, commands: [{
        kind: "respond",
        requestId,
        body: response?.subtype === "error" || error !== null
          ? { kind: "rejected", reason: error ?? "control request failed", native: message }
          : { kind: "accepted", native: message },
      }] };
    }
    case "control_request": {
      // claude asks the app something (permission, question). Recorded verbatim; the adapter answers nothing.
      const id = typeof message.request_id === "string" ? message.request_id : `claude-${String(Date.now())}`;
      const request = asRecord(message.request);
      const subtype = typeof request?.subtype === "string" ? request.subtype : "control_request";
      return {
        state,
        commands: [
          { kind: "event", body: { type, native: message, views: [] }, agentPath },
          { kind: "toApp", id, type: subtype, native: message },
        ],
      };
    }
    default:
      return event({ views: [] });
  }
}
