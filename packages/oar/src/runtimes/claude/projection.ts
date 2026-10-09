import { claudeServiceTierEvents } from "./service-tier.js";
import type {
  FrameBody,
  RuntimeEventBody,
  ResponseBody,
  TokenTotals,
  TurnOutcome,
} from "../../contracts/session.js";
import { claudeFailure } from "./failure.js";
import { asNumber, asRecord, type JsonRecord } from "../../shared/json.js";
import { addTokens, cacheParts, noTokens } from "../../shared/token-totals.js";
import { toolContent } from "../../shared/tool-output.js";
import { claudeContextUsageFromResult } from "./context-usage.js";
import { claudeTaskViews } from "./tasks.js";
import { claudeContent, contentBlocks, type ClaudePartials } from "./content.js";

/**
 * The claude stdout → record projection as a PURE FOLD. A reducer over the
 * raw stream-json frames that emits kernel COMMANDS (append an event with its
 * attribution, answer one of our control requests, surface a runtime→app
 * request) instead of touching the kernel itself. The live adapter applies
 * the commands to a real kernel; tests apply them to nothing and snapshot the
 * list. No transport, no side effects, so it is trivially unit-testable and
 * shared verbatim between live and replay.
 *
 * Rules the fold enforces: EVERY frame becomes exactly one frame
 * (verbatim `native`, events in block order); nothing is gated on whether a
 * turn is "open"; the turn's end is claude's own `result` frame; attribution
 * comes from `parent_tool_use_id` (a child's path is its parent's path plus
 * the Task tool_use id that spawned it).
 */

export type ProjectionCommand =
  | { readonly kind: "frame"; readonly body: FrameBody; readonly agentPath: readonly string[] }
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
 * `tokens` accumulates per-agent result usage so usage events are cumulative.
 * `failureCategory` is the `error` of the turn's last root assistant frame,
 * which classifies a failed result (failure.ts).
 */
export interface ClaudeProjectionState {
  readonly abortRequested: boolean;
  readonly agents: ReadonlyMap<string, readonly string[]>;
  readonly tokens: ReadonlyMap<string, TokenTotals>;
  readonly partials: ClaudePartials;
  readonly failureCategory: string | null;
}

export const initialClaudeProjection: ClaudeProjectionState = {
  abortRequested: false,
  agents: new Map(),
  tokens: new Map(),
  partials: new Map(),
  failureCategory: null,
};

/** Control plane → state: a prompt clears any stale abort intent; an abort arms it. */
export function claudePrompted(state: ClaudeProjectionState): ClaudeProjectionState {
  return { ...state, abortRequested: false };
}

export function claudeAbortRequested(state: ClaudeProjectionState): ClaudeProjectionState {
  return { ...state, abortRequested: true };
}

function toolResultViews(message: JsonRecord): RuntimeEventBody[] {
  const out: RuntimeEventBody[] = [];
  for (const block of contentBlocks(message)) {
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      const content = toolContent(block.content);
      // The Messages API defines `is_error` as optional and false by
      // default, and claude 2.1.288 leaves it out of a successful Read, Write
      // or Edit result (Bash carries `false`): an absent field is the
      // protocol's own "no error", not a missing report.
      out.push({
        kind: "tool_call_ended",
        callId: block.tool_use_id,
        ...(content === undefined ? {} : { content }),
        result: block.is_error === true ? "failed" : "ok",
      });
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
    return claudeFailure(reason, {
      category: state.failureCategory,
      status: asNumber(message.api_error_status),
      terminalReason: typeof message.terminal_reason === "string" ? message.terminal_reason : null,
    });
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
  // `input_tokens` excludes the cache reads and writes, so input counts them
  // back in; each also stands as its own part when the frame reports it.
  const cache = cacheParts(usage, { read: "cache_read_input_tokens", write: "cache_creation_input_tokens" });
  const tokens = addTokens(state.tokens.get(pathKey(agentPath)) ?? noTokens, {
    input: (asNumber(usage.input_tokens) ?? 0) + (cache.cacheRead ?? 0) + (cache.cacheWrite ?? 0),
    output: asNumber(usage.output_tokens) ?? 0,
    ...cache,
  });
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
  const event = (body: Omit<FrameBody, "type" | "native">, next: ClaudeProjectionState = state): { state: ClaudeProjectionState; commands: ProjectionCommand[] } =>
    ({ state: next, commands: [{ kind: "frame", body: { type, native: message, ...body }, agentPath }] });

  switch (String(message.type)) {
    case "assistant":
    case "stream_event": {
      const content = claudeContent(state.partials, message, agentPath);
      const next = { ...state, partials: content.partials };
      if (message.type !== "assistant") {
        return event({ events: content.events }, next);
      }
      const remembered = rememberToolUses(next, message, agentPath);
      // The category of an error claude reports as an assistant message.
      const failureCategory = agentPath.length === 0 && typeof message.error === "string" ? message.error : remembered.failureCategory;
      return event({ events: content.events }, { ...remembered, failureCategory });
    }
    case "user": {
      const views = [...toolResultViews(message)];
      const body = asRecord(message.message);
      if (message.isReplay === true && typeof message.uuid === "string" && Array.isArray(body?.content)) {
        const input = body.content.map((part: unknown) => asRecord(part)).filter((part) => part?.type === "text").map((part) => typeof part?.text === "string" ? part.text : "").join("");
        views.push({ kind: "user_message", input, inputId: message.uuid, nativeMessageId: message.uuid, evidence: "acknowledged" });
      }
      return event({ events: views });
    }
    case "result": {
      const events: RuntimeEventBody[] = [...claudeServiceTierEvents(message), { kind: "turn_ended", outcome: resultOutcome(state, message) }];
      const accumulated = accumulate(state, agentPath, message);
      const context = claudeContextUsageFromResult(message);
      if (accumulated !== null || context !== null) {
        events.push({ kind: "usage", usage: {
          ...(context === null ? {} : { context }),
          ...(accumulated === null ? {} : { tokens: accumulated.tokens }),
        } });
      }
      return event({ events }, { ...(accumulated?.state ?? state), abortRequested: false, failureCategory: null });
    }
    case "system": {
      if (message.subtype === "compact_boundary") {
        // claude reports compaction only after the fact: the boundary frame
        // carries compact_metadata {trigger: manual | auto, pre_tokens, …}
        // ([sym] 2.1.272); there is no start frame, so no compaction_started.
        const trigger = asRecord(message.compact_metadata)?.trigger;
        return event({ events: [{ kind: "compaction_ended", outcome: "completed", ...(typeof trigger === "string" ? { trigger } : {}) }] });
      }
      const model = message.subtype === "init" && typeof message.model === "string" ? message.model : null;
      return event({ events: [...(model === null ? claudeTaskViews(message) : [{ kind: "model" as const, model }]), ...claudeServiceTierEvents(message)] });
    }
    case "control_response": {
      // claude answering one of OUR control_requests (interrupt): the frame IS
      // the response record (native verbatim); one frame, one record, so it
      // is not also recorded as an event. A control_response we cannot pair
      // is recorded as a plain event.
      const response = asRecord(message.response);
      const initialized = asRecord(response?.response);
      if (response?.subtype === "success" && initialized !== null) {
        const events = claudeServiceTierEvents(initialized);
        if (events.length > 0) { return event({ events }); }
      }
      const requestId = typeof response?.request_id === "string" ? response.request_id : null;
      if (requestId === null) {
        return event({ events: [] });
      }
      const error = typeof response?.error === "string" ? response.error : null;
      return { state, commands: [{
        kind: "respond",
        requestId,
        body: response?.subtype === "error" || error !== null
          ? { kind: "rejected", code: "runtime_refused", reason: error ?? "control request failed", native: message }
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
          { kind: "frame", body: { type, native: message, events: [] }, agentPath },
          { kind: "toApp", id, type: subtype, native: message },
        ],
      };
    }
    case "control_cancel_request":
      // claude withdrew a request it had sent us (an interrupt cancels a pending question).
      return event({ events: typeof message.request_id === "string" ? [{ kind: "app_request_cancelled", requestId: message.request_id }] : [] });
    default:
      return event({ events: [] });
  }
}
