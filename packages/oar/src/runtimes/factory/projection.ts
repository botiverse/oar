import type { FrameBody, RuntimeEventBody, TokenTotals, TurnOutcome } from "../../contracts/session.js";
import type { FailureClass } from "../../contracts/failure.js";
import type { ToolOutputPart } from "../../contracts/tool-output.js";
import { classifyFailure } from "../../shared/failure-class.js";
import { asNumber, asRecord, asRecordList, type JsonRecord } from "../../shared/json.js";
import { addTokens, noTokens } from "../../shared/token-totals.js";

/*
 * Pure fold over droid's stream-jsonrpc notifications (docs/runtimes/factory.md
 * has the mapping and the probes behind it). One notification line is one
 * frame; `type` is the `droid.session_notification` subtype, or the method
 * for any other notification. Turn and input bookkeeping that needs control
 * state (which turn OAR prompted, which steer an RPC id belongs to) is part
 * of the state, set by the session; the fold never decides control.
 */

/** A steer or prompt OAR sent with `droid.add_user_message`: its RPC id is the OAR request id, its `messageId` the input id. */
export interface FactorySentInput {
  readonly requestId: string;
  readonly inputId: string;
}

export interface FactoryProjection {
  /** Tool calls already announced: later `tool_call` frames for the same id carry the grown input. */
  readonly toolCalls: ReadonlySet<string>;
  /** The latest `error` notification of the running turn: its reason when the turn ends badly. */
  readonly turnError: string | null;
  /** The root's own tokens since this Session opened, summed from `agent_turn_completed.tokenUsage`. */
  readonly usage: TokenTotals;
  /** Sub-agent tokens (`childTokenUsage`) since this Session opened, once any sub-agent reported some. */
  readonly children: TokenTotals | null;
  /** Inputs OAR sent, by RPC id, until their turn ends. */
  readonly sent: ReadonlyMap<string, FactorySentInput>;
  /** The turn id (an input's `messageId`) whose turn droid is running; null while idle. */
  readonly turnId: string | null;
  /** Handed-back input ids whose late `agent_turn_completed` should not end a newer turn. */
  readonly droppedTurns: ReadonlySet<string>;
}

export const initialFactoryProjection: FactoryProjection = {
  toolCalls: new Set(), turnError: null, usage: noTokens, children: null, sent: new Map(), turnId: null, droppedTurns: new Set(),
};

/** Factory's token usage (`TokenUsage`): input excludes the cache parts, which droid reports beside it. */
export function factoryTokens(usage: JsonRecord | null): TokenTotals | null {
  if (usage === null) { return null; }
  const input = asNumber(usage.inputTokens);
  const output = asNumber(usage.outputTokens);
  if (input === null || output === null) { return null; }
  const cacheRead = asNumber(usage.cacheReadTokens);
  const cacheWrite = asNumber(usage.cacheCreationTokens);
  return {
    input: input + (cacheRead ?? 0) + (cacheWrite ?? 0), output,
    ...(cacheRead === null ? {} : { cacheRead }),
    ...(cacheWrite === null ? {} : { cacheWrite }),
  };
}

// Factory droid protocol 1.340.0 `agent_turn_completed.reason` (19-value union).
const reasonFailure: Readonly<Record<string, FailureClass>> = {
  model_usage_exhausted: "quota", // [schema] droid protocol 1.340.0
  model_rate_limited: "rate_limited", // [schema] droid protocol 1.340.0
  model_authentication_failed: "auth", // [env] scripted 401 (factory.vendor.test.ts)
  model_request_rejected: "invalid_request", // [schema] droid protocol 1.340.0
  prompt_rejected: "invalid_request", // [schema] droid protocol 1.340.0
  model_provider_unreachable: "provider", // [schema] droid protocol 1.340.0
  model_provider_unavailable: "provider", // [schema] droid protocol 1.340.0
  structured_output_missing: "output_schema", // [schema] droid protocol 1.340.0
  structured_output_invalid: "output_schema", // [schema] droid protocol 1.340.0
  structured_output_schema_invalid: "output_schema", // [schema] droid protocol 1.340.0
  process_exit: "runtime_exited", // [schema] droid protocol 1.340.0
};

/** `agent_turn_completed.reason` (19 values in protocol 1.340.0) as an OAR outcome; the reason text is droid's last `error` of the turn. */
export function factoryOutcome(reason: unknown, turnError: string | null): TurnOutcome {
  if (reason === "completed" || reason === "spec_handoff") { return { kind: "completed" }; }
  if (reason === "cancelled") { return { kind: "aborted" }; }
  const native = typeof reason === "string" ? reason : "error";
  const text = turnError ?? `Factory droid turn ended: ${native}`;
  const failure = reasonFailure[native] ?? classifyFailure(text);
  return failure === "auth" || failure === "quota" ? { kind: "failed", failure, reason: text } : { kind: "failed", failure, reason: text };
}

function toolContent(content: unknown): readonly ToolOutputPart[] | undefined {
  if (typeof content === "string") { return [{ type: "text", text: content }]; }
  if (!Array.isArray(content)) { return undefined; }
  return content.map((block): ToolOutputPart => {
    const part = asRecord(block);
    if (part?.type === "text" && typeof part.text === "string") { return { type: "text", text: part.text }; }
    const source = asRecord(part?.source);
    if (part?.type === "image" && typeof source?.data === "string" && typeof source.media_type === "string") {
      return { type: "image", mediaType: source.media_type, data: source.data };
    }
    return { type: "other", value: block };
  });
}

function messageText(message: JsonRecord): string {
  return asRecordList(message.content).flatMap(part => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("");
}

/** Text of a JSON input, as OAR shows tool input elsewhere. */
function inputText(input: unknown): string { return JSON.stringify(input ?? {}); }

export interface FactoryFold {
  readonly state: FactoryProjection;
  readonly body: FrameBody;
}

/** One droid notification line → its frame and the next state. */
export function foldFactoryNotification(state: FactoryProjection, message: JsonRecord): FactoryFold {
  const method = typeof message.method === "string" ? message.method : "notification";
  const params = asRecord(message.params) ?? {};
  const notification = method === "droid.session_notification" ? asRecord(params.notification) : null;
  const type = typeof notification?.type === "string" ? notification.type : method;
  const frame = (events: readonly RuntimeEventBody[], next: FactoryProjection = state, responseTo?: string): FactoryFold =>
    ({ state: next, body: { type, native: message, events, ...(responseTo === undefined ? {} : { responseTo }) } });
  if (notification === null) { return frame([]); }
  switch (notification.type) {
    case "settings_updated": {
      const settings = asRecord(notification.settings);
      return frame([
        ...(typeof settings?.modelId === "string" ? [{ kind: "model" as const, model: settings.modelId }] : []),
        ...(typeof settings?.reasoningEffort === "string" ? [{ kind: "effort" as const, effort: settings.reasoningEffort }] : []),
      ]);
    }
    case "assistant_text_delta":
      return typeof notification.textDelta === "string" && notification.textDelta !== ""
        ? frame([{ kind: "text_delta", text: notification.textDelta, ...(typeof notification.messageId === "string" ? { messageId: notification.messageId } : {}) }])
        : frame([]);
    case "thinking_text_delta":
      return typeof notification.textDelta === "string" && notification.textDelta !== ""
        ? frame([{ kind: "reasoning", content: { kind: "text", text: notification.textDelta }, ...(typeof notification.messageId === "string" ? { messageId: notification.messageId } : {}) }])
        : frame([]);
    case "tool_call": {
      const toolUse = asRecord(notification.toolUse);
      const id = toolUse?.id;
      if (typeof id !== "string") { return frame([]); }
      if (state.toolCalls.has(id)) { return frame([{ kind: "tool_call_input", callId: id, input: inputText(toolUse?.input) }]); }
      return frame([{ kind: "tool_call_started", callId: id, tool: typeof toolUse?.name === "string" ? toolUse.name : "unknown", input: inputText(toolUse?.input) }],
        { ...state, toolCalls: new Set([...state.toolCalls, id]) });
    }
    case "tool_result": {
      const id = notification.toolUseId;
      if (typeof id !== "string") { return frame([]); }
      const content = toolContent(notification.content);
      return frame([{ kind: "tool_call_ended", callId: id, ...(content === undefined ? {} : { content }),
        ...(typeof notification.isError === "boolean" ? { result: notification.isError ? "failed" as const : "ok" as const } : {}) }]);
    }
    case "create_message": {
      const created = asRecord(notification.message);
      const requestId = typeof notification.requestId === "string" ? notification.requestId : undefined;
      const sent = requestId === undefined ? undefined : state.sent.get(requestId);
      if (created?.role !== "user" || sent === undefined || created.id !== sent.inputId) { return frame([]); }
      // droid echoes the user message OAR sent, under the `messageId` OAR chose and the RPC id it was sent with.
      const remaining = new Map(state.sent);
      remaining.delete(sent.requestId);
      return frame([{ kind: "user_message", input: messageText(created), inputId: sent.inputId, nativeMessageId: sent.inputId,
        ...(state.turnId === null ? {} : { turnId: state.turnId }), evidence: "turn_item" }], { ...state, sent: remaining });
    }
    case "queued_messages_discarded":
    case "queued_message_handed_back": {
      // An interrupt drops steering droid had queued but not yet drained; the RPC ids name the exact attempts.
      const drained: readonly unknown[] = Array.isArray(notification.drainedRequestIds) ? notification.drainedRequestIds : [];
      const named: unknown[] = [...drained, ...asRecordList(notification.messages).map(entry => entry.requestId), notification.requestId];
      const ids = [...new Set(named.filter((id): id is string => typeof id === "string"))];
      const dropped = ids.flatMap(id => { const sent = state.sent.get(id); return sent === undefined ? [] : [sent]; });
      const remaining = new Map(state.sent);
      const droppedTurns = new Set(state.droppedTurns);
      let { turnId } = state;
      for (const input of dropped) {
        remaining.delete(input.requestId);
        if (notification.type === "queued_message_handed_back") {
          droppedTurns.add(input.inputId);
          if (turnId === input.inputId) { turnId = null; }
        }
      }
      return frame(dropped.map(input => ({ kind: "input_dropped" as const, reason: "turn_interrupted" as const, requestId: input.requestId, inputId: input.inputId })),
        { ...state, sent: remaining, turnId, droppedTurns });
    }
    case "error":
      return frame([], { ...state, turnError: typeof notification.message === "string" ? notification.message : state.turnError });
    case "llm_retry": {
      const attempt = asNumber(notification.attempt);
      return attempt === null ? frame([]) : frame([{ kind: "retry", attempt, ...(typeof notification.reason === "string" ? { reason: notification.reason } : {}) }]);
    }
    case "session_compacted":
      return frame([{ kind: "compaction_ended", outcome: "completed" }]);
    case "agent_turn_completed": {
      const turnTokens = factoryTokens(asRecord(notification.tokenUsage));
      const childTokens = factoryTokens(asRecord(notification.childTokenUsage));
      const usage = turnTokens === null ? state.usage : addTokens(state.usage, turnTokens);
      const childReported = childTokens !== null && (childTokens.input > 0 || childTokens.output > 0);
      const children = childReported ? addTokens(state.children ?? noTokens, childTokens) : state.children;
      const turnId = typeof notification.turnId === "string" ? notification.turnId : undefined;
      const usageEvent = turnTokens === null ? [] : [{ kind: "usage" as const, usage: { tokens: usage, ...(children === null ? {} : { total: addTokens(usage, children) }) } }];
      if (turnId !== undefined && state.droppedTurns.has(turnId)) {
        const droppedTurns = new Set(state.droppedTurns);
        droppedTurns.delete(turnId);
        return frame(usageEvent, { ...state, usage, children, droppedTurns });
      }
      const outcome = factoryOutcome(notification.reason, state.turnError);
      const sent = new Map([...state.sent].filter(([, input]) => input.inputId !== turnId));
      return frame([
        ...usageEvent,
        { kind: "turn_ended", outcome, ...(turnId === undefined ? {} : { inputId: turnId }) },
      ], { ...state, usage, children, turnError: null, turnId: state.turnId === turnId ? null : state.turnId, sent });
    }
    default:
      return frame([]);
  }
}
