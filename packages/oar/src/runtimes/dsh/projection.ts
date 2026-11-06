import type { FailureClass, FrameBody, RuntimeEventBody, TokenTotals, TurnOutcome } from "../../contracts/session.js";
import { asNumber, asRecord, asRecordList, type JsonRecord } from "../../shared/json.js";
import { failureFromStatus } from "../../shared/failure-class.js";
import { addTokens, noTokens } from "../../shared/token-totals.js";
import { toolContent } from "../../shared/tool-output.js";
import { dshJobEvents } from "./jobs.js";

/** What one session's native log has said so far. An input without a native id keeps its position as null. */
export interface DshSessionFold {
  readonly nextTurn: readonly (string | null)[];
  readonly nextStep: readonly (string | null)[];
  readonly turnOpen: boolean;
  readonly tokens: TokenTotals;
  readonly contextWindow: number | null;
}

export interface DshProjection {
  readonly rootId: string;
  readonly sessions: Readonly<Record<string, DshSessionFold>>;
  /** Lineage already said, as `parent child`: a catalog entry can repeat with a later version. */
  readonly links: readonly string[];
}

export interface DshFolded {
  readonly state: DshProjection;
  /** Exactly one frame for one native payload; a child session's frame says whose it is. */
  readonly frame: { readonly body: FrameBody; readonly sessionId?: string };
}

const emptySession: DshSessionFold = { nextTurn: [], nextStep: [], turnOpen: false, tokens: noTokens, contextWindow: null };

export function initialDshProjection(rootId: string): DshProjection {
  return { rootId, sessions: {}, links: [] };
}

/**
 * The runtime's own machine-routing codes. Observed from a scripted provider:
 * AUTH (401), RATE_LIMIT (429), SERVER (500), INVALID_REQUEST (400), UNKNOWN_MODEL,
 * NO_ADAPTER and UNSUPPORTED_REASONING_EFFORT. The others are named constants in
 * dsh-llm 0.2.1-rc.5 not yet seen on a wire. PI_AI_ERROR (a 402, for one) and
 * UNKNOWN carry no class; the text is prose, never parsed.
 */
const FAILURE_CODES: ReadonlyMap<string, FailureClass> = new Map([
  ["AUTH", "auth"],
  ["INVALID_CREDENTIAL", "auth"],
  ["ACCOUNT_QUOTA", "quota"],
  ["QUOTA", "quota"],
  ["RATE_LIMIT", "rate_limited"],
  ["CONTEXT_WINDOW_EXCEEDED", "input_too_large"],
  ["UNKNOWN_MODEL", "model_unavailable"],
  ["NO_ADAPTER", "model_unavailable"],
  ["UNSUPPORTED_REASONING_EFFORT", "invalid_request"],
  ["INVALID_REQUEST", "invalid_request"],
  ["SERVER", "provider"],
]);

/** The class of a native `LlmFailure`: its code first, then the HTTP status where it carries one. */
export function dshFailureClass(failure: JsonRecord | null): FailureClass {
  const code = typeof failure?.code === "string" ? FAILURE_CODES.get(failure.code) : undefined;
  if (code !== undefined) { return code; }
  const status = asNumber(failure?.status);
  return status === null ? "unknown" : failureFromStatus(status);
}

/** A native turn end. Only `completed` and a cancellation are not failures; an unknown reason is reported, never assumed fine. */
export function dshTurnOutcome(reason: JsonRecord | null): TurnOutcome {
  switch (reason?.kind) {
    case "completed": return { kind: "completed" };
    case "aborted": return { kind: "aborted" };
    case "error": {
      const failure = asRecord(reason.error);
      const status = asNumber(failure?.status);
      const message = typeof failure?.message === "string" ? failure.message : "DSH reported a failed turn";
      return { kind: "failed", failure: dshFailureClass(failure), reason: message, ...(status === null ? {} : { status }) };
    }
    case "max-tokens": return { kind: "failed", failure: "limit_reached", reason: "DSH ended the turn at its output-token limit" };
    case "blocked": return { kind: "failed", failure: "unknown", reason: "DSH reported the turn blocked" };
    // Closes a log whose process died mid-turn; the loop never says it live.
    case "interrupted": return { kind: "failed", failure: "runtime_exited", reason: "DSH closed a turn its earlier process never finished" };
    default: return { kind: "failed", failure: "unknown", reason: `DSH ended the turn with ${JSON.stringify(reason?.kind ?? null)}` };
  }
}

const inputIdOf = (message: JsonRecord): string | null => typeof message.id === "string" ? message.id : null;

function textOf(content: unknown): string {
  return asRecordList(content).flatMap((block) => block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("");
}

/** One native report. `inputTokens` excludes the cache counts DSH reports beside it; `TokenTotals.input` includes them. */
function tokensOf(usage: JsonRecord | null): TokenTotals | null {
  const input = asNumber(usage?.inputTokens);
  const output = asNumber(usage?.outputTokens);
  if (input === null || output === null) { return null; }
  const cacheRead = asNumber(usage?.cacheReadTokens);
  const cacheWrite = asNumber(usage?.cacheWriteTokens);
  const reasoning = asNumber(usage?.reasoningTokens);
  return {
    input: input + (cacheRead ?? 0) + (cacheWrite ?? 0), output,
    ...(reasoning === null ? {} : { reasoning }),
    ...(cacheRead === null ? {} : { cacheRead }),
    ...(cacheWrite === null ? {} : { cacheWrite }),
  };
}

/** What an attempt that committed no message spent: the last usage chunk of its embedded stream. */
function attemptUsage(stream: unknown): JsonRecord | null {
  const reports = asRecordList(stream).flatMap((entry) => {
    const chunk = asRecord(entry.chunk);
    return chunk?.type === "usage" ? [asRecord(chunk.usage)] : [];
  });
  return reports.at(-1) ?? null;
}

function spent(session: DshSessionFold, usage: JsonRecord | null, committed: boolean): { readonly session: DshSessionFold; readonly events: readonly RuntimeEventBody[] } {
  const report = tokensOf(usage);
  if (report === null || (!committed && report.input === 0 && report.output === 0)) { return { session, events: [] }; }
  const tokens = addTokens(session.tokens, report);
  // A call's own total is its context on the next request; a failed attempt adds nothing to the context.
  const total = committed ? asNumber(usage?.totalTokens) : null;
  const percent = total === null || session.contextWindow === null || session.contextWindow <= 0 ? null : Math.round((total / session.contextWindow) * 100);
  return { session: { ...session, tokens }, events: [{ kind: "usage", usage: {
    tokens,
    ...(total === null ? {} : { context: { tokens: total, contextWindow: session.contextWindow, percent } }),
  } }] };
}

/** A native inbox splice. No outcome means the loop claimed the input; `canceled` means it was discarded. */
function spliced(session: DshSessionFold, data: JsonRecord, cause: unknown): { readonly session: DshSessionFold; readonly events: readonly RuntimeEventBody[] } {
  const target = data.target === "next-step" ? "nextStep" : "nextTurn";
  const list = session[target];
  const start = asNumber(data.start) ?? 0;
  const removedCount = asNumber(data.removedCount) ?? 0;
  const removed = list.slice(start, start + removedCount).flatMap((id) => id === null ? [] : [id]);
  const inserted = asRecordList(data.inserted).map((message) => inputIdOf(message));
  const next = { ...session, [target]: list.toSpliced(start, removedCount, ...inserted) };
  if (data.outcome === "canceled") {
    return { session: next, events: cause === "withdraw" ? [] : removed.map((inputId) => ({ kind: "input_dropped", inputId, reason: "turn_interrupted" })) };
  }
  // A prompt behind input a crashed process left waiting runs after it, so it is not yet started.
  const behind = cause === "prompt" && target === "nextTurn" && list.length > 0
    ? inserted.flatMap((inputId): RuntimeEventBody[] => inputId === null ? [] : [{ kind: "input_queued", inputId }]) : [];
  return { session: next, events: target === "nextTurn" ? [...removed.map((inputId): RuntimeEventBody => ({ kind: "turn_active", inputId })), ...behind] : [] };
}

function toolEnd(message: JsonRecord): readonly RuntimeEventBody[] {
  if (typeof message.toolCallId !== "string") { return []; }
  const content = toolContent(message.content);
  return [{ kind: "tool_call_ended", callId: message.toolCallId,
    ...(content === undefined ? {} : { content }),
    ...(typeof message.isError === "boolean" ? { result: message.isError ? "failed" : "ok" } : {}) }];
}

function sessionEvent(state: DshProjection, sessionId: string, session: DshSessionFold, event: JsonRecord, cause: unknown): { readonly session: DshSessionFold; readonly links: readonly string[]; readonly events: readonly RuntimeEventBody[] } {
  const data = asRecord(event.data) ?? {};
  const unchanged = { session, links: state.links };
  switch (event.type) {
    case "job/registered":
    case "job/settled":
      return { ...unchanged, events: dshJobEvents(event.type, data, sessionId) };
    case "agent/inbox/spliced":
      return { ...spliced(session, data, cause), links: state.links };
    case "turn/start":
      // The claim that follows names the input when one is waiting.
      return { session: { ...session, turnOpen: true }, links: state.links, events: session.nextTurn.length === 0 ? [{ kind: "turn_active" }] : [] };
    case "turn/end":
      return { session: { ...session, turnOpen: false }, links: state.links, events: [{ kind: "turn_ended", outcome: dshTurnOutcome(asRecord(data.reason)) }] };
    case "user/message": {
      const inputId = inputIdOf(data);
      if (asRecord(data.source)?.kind !== "user") { return { ...unchanged, events: [] }; }
      return { ...unchanged, events: [{ kind: "user_message", input: textOf(data.content), ...(inputId === null ? {} : { inputId, nativeMessageId: inputId }), evidence: "turn_item" }] };
    }
    case "tool/call":
      return { ...unchanged, events: typeof data.callId === "string" && typeof data.name === "string"
        ? [{ kind: "tool_call_started", callId: data.callId, tool: data.name, ...(typeof data.arguments === "string" ? { input: data.arguments } : {}) }] : [] };
    case "tool/result":
      return { ...unchanged, events: toolEnd(asRecord(data.message) ?? {}) };
    case "assistant/message":
      return { ...spent(session, asRecord(data.usage), true), links: state.links };
    case "assistant/attempt":
      return { ...spent(session, attemptUsage(data.stream), false), links: state.links };
    case "request/context":
      return { session: { ...session, contextWindow: asNumber(data.contextWindow) ?? session.contextWindow }, links: state.links, events: [] };
    case "request/header": {
      const config = asRecord(asRecord(data.header)?.config);
      return { ...unchanged, events: [
        ...(typeof config?.provider === "string" && typeof config.model === "string" ? [{ kind: "model" as const, model: `${config.provider}/${config.model}` }] : []),
        ...(typeof config?.reasoningEffort === "string" ? [{ kind: "effort" as const, effort: config.reasoningEffort }] : []),
      ] };
    }
    case "subagent/catalog": {
      if (typeof data.childId !== "string") { return { ...unchanged, events: [] }; }
      const link = `${sessionId} ${data.childId}`;
      return state.links.includes(link) ? { ...unchanged, events: [] }
        : { session, links: [...state.links, link], events: [{ kind: "session_linked", parent: sessionId, child: data.childId, via: "tool_call" }] };
    }
    case "compaction/start":
      return { ...unchanged, events: [{ kind: "compaction_started", ...(typeof data.compactionId === "string" ? { compactionId: data.compactionId } : {}) }] };
    case "compaction/end":
      return { ...unchanged, events: [{ kind: "compaction_ended", ...(typeof data.compactionId === "string" ? { compactionId: data.compactionId } : {}),
        ...(typeof data.error === "string" ? { outcome: "failed" as const, reason: data.error } : { outcome: "completed" as const }) }] };
    default:
      return { ...unchanged, events: [] };
  }
}

/** Transient chunks only: the durable `assistant/message` repeats this text and adds no second copy. */
function streamEvents(frame: JsonRecord): readonly RuntimeEventBody[] {
  const chunk = asRecord(frame.chunk);
  const messageId = typeof frame.attemptId === "string" ? { messageId: frame.attemptId } : {};
  switch (chunk?.type) {
    case "text-delta":
      return typeof chunk.text === "string" ? [{ kind: "text_delta", text: chunk.text, ...messageId }] : [];
    case "reasoning-delta":
      return typeof chunk.text === "string" ? [{ kind: "reasoning", content: { kind: "text", text: chunk.text }, ...messageId }] : [];
    case "tool-call-delta":
      return typeof chunk.id === "string" && typeof chunk.argumentsDelta === "string" ? [{ kind: "tool_call_input_delta", callId: chunk.id, delta: chunk.argumentsDelta }] : [];
    default:
      return [];
  }
}

function subagentEvents(channel: unknown, info: JsonRecord): readonly RuntimeEventBody[] {
  if (typeof info.runId !== "string") { return []; }
  if (channel === "subagent/start") {
    return [{ kind: "task_started", taskId: info.runId, taskType: "agent",
      ...(typeof info.provider === "string" ? { nativeType: info.provider } : {}),
      ...(typeof info.id === "string" ? { childSessionId: info.id } : {}) }];
  }
  // `error`, `max-tokens`, `refusal` and any later reason all mean the child did not finish its task.
  const status = info.stopReason === "completed" ? "completed" : (info.stopReason === "aborted" ? "stopped" : "failed");
  return [{ kind: "task_ended", taskId: info.runId, status }];
}

/** The native payload of a bridge line, unchanged, without its routing fields. */
function payloadOf(message: JsonRecord): unknown {
  const { channel } = message;
  if (channel === "session/event") { return message.event; }
  if (channel === "agent/assistant-stream") { return message.frame; }
  if (channel === "subagent/start" || channel === "subagent/end") { return message.info; }
  const { type: _type, channel: _channel, sessionId: _sessionId, cause: _cause, ...rest } = message;
  return rest;
}

/** Fold one line of the bridge into its frame. Pure: replay of the same lines gives the same records. */
export function foldDsh(state: DshProjection, message: JsonRecord): DshFolded {
  if (message.type !== "native") {
    return { state, frame: { body: { type: `dsh/${String(message.type)}`, native: message, events: [] } } };
  }
  const sessionId = typeof message.sessionId === "string" ? message.sessionId : state.rootId;
  const at = sessionId === state.rootId ? {} : { sessionId };
  // Native ids are data: only a session this fold recorded counts, never an inherited property.
  const session = (Object.hasOwn(state.sessions, sessionId) ? state.sessions[sessionId] : undefined) ?? emptySession;
  const native = payloadOf(message);
  if (message.channel === "session/event") {
    const event = asRecord(native) ?? {};
    const next = sessionEvent(state, sessionId, session, event, message.cause);
    return {
      state: { ...state, links: next.links, sessions: { ...state.sessions, [sessionId]: next.session } },
      frame: { ...at, body: { type: `session/event:${String(event.type)}`, native, events: next.events } },
    };
  }
  const events = message.channel === "agent/assistant-stream" ? streamEvents(asRecord(native) ?? {})
    : (message.channel === "subagent/start" || message.channel === "subagent/end" ? subagentEvents(message.channel, asRecord(native) ?? {}) : []);
  return { state, frame: { ...at, body: { type: String(message.channel), native, events } } };
}

/** The frame that says what a native open returned; alpha releases report a model selection already. */
export function dshOpenedFrame(result: JsonRecord): FrameBody {
  const model = asRecord(result.model);
  return { type: "dsh/opened", native: result, events: [
    ...(typeof model?.provider === "string" && typeof model.model === "string" ? [{ kind: "model" as const, model: `${model.provider}/${model.model}` }] : []),
    ...(typeof model?.reasoningEffort === "string" ? [{ kind: "effort" as const, effort: model.reasoningEffort }] : []),
  ] };
}
