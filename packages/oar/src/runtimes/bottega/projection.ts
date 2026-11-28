import type { FrameBody, RuntimeEventBody, TokenTotals, TurnOutcome } from "../../contracts/session.js";
import { asNumber, asRecord, type JsonRecord } from "../../shared/json.js";
import { addTokens, noTokens } from "../../shared/token-totals.js";

/** What the session's lines have said so far. */
export interface BottegaProjection {
  readonly turnOpen: boolean;
  readonly tokens: TokenTotals;
  /** The route last reported, as `provider/model`. */
  readonly model: string | null;
}

export const initialBottegaProjection: BottegaProjection = { turnOpen: false, tokens: noTokens, model: null };

export interface BottegaFolded {
  readonly state: BottegaProjection;
  /** Exactly one frame for one line. */
  readonly body: FrameBody;
}

const stringOf = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * A turn's end in bottega's own word. `capped` is the session's step limit:
 * the turn stopped before the agent ended it. A failure's text is prose and
 * is never parsed for a class.
 */
export function bottegaTurnOutcome(message: JsonRecord): TurnOutcome {
  const reason = stringOf(message.reason);
  switch (message.outcome) {
    case "completed": return { kind: "completed" };
    case "aborted": return { kind: "aborted" };
    case "capped": return { kind: "failed", failure: "limit_reached", reason: reason ?? "bottega stopped the turn at its step limit" };
    case "failed": return { kind: "failed", failure: "unknown", reason: reason ?? "bottega reported a failed turn" };
    default: return { kind: "failed", failure: "unknown", reason: `bottega ended the turn with ${JSON.stringify(message.outcome ?? null)}` };
  }
}

/** One model call. bottega reports `input` beside the cache counts; `TokenTotals.input` includes them. */
function stepTokens(usage: JsonRecord | null): TokenTotals | null {
  const input = asNumber(usage?.input);
  const output = asNumber(usage?.output);
  if (input === null || output === null) { return null; }
  const cacheRead = asNumber(usage?.cacheRead);
  const cacheWrite = asNumber(usage?.cacheWrite);
  return {
    input: input + (cacheRead ?? 0) + (cacheWrite ?? 0), output,
    ...(cacheRead === null ? {} : { cacheRead }),
    ...(cacheWrite === null ? {} : { cacheWrite }),
  };
}

function step(state: BottegaProjection, message: JsonRecord): { readonly state: BottegaProjection; readonly events: readonly RuntimeEventBody[] } {
  const provider = stringOf(message.provider);
  const name = stringOf(message.model);
  const model = provider !== undefined && name !== undefined ? `${provider}/${name}` : state.model;
  const route: RuntimeEventBody[] = model !== null && model !== state.model ? [{ kind: "model", model }] : [];
  const report = stepTokens(asRecord(message.usage));
  if (report === null) { return { state: { ...state, model }, events: route }; }
  const tokens = addTokens(state.tokens, report);
  // The session's context is its budget, whatever the model's window: the screen is drawn to fit it.
  const contextWindow = asNumber(message.contextBudget);
  const percent = contextWindow === null || contextWindow <= 0 ? null : Math.round((report.input / contextWindow) * 100);
  return { state: { ...state, model, tokens }, events: [...route, { kind: "usage", usage: { tokens, context: { tokens: report.input, contextWindow, percent } } }] };
}

/** One thing the agent did. Text it wrote without sending (`unsent`) reached nobody: it is reasoning, not a call. */
function action(message: JsonRecord): readonly RuntimeEventBody[] {
  const callId = stringOf(message.id);
  const tool = stringOf(message.tool);
  const note = typeof message.note === "string" ? message.note : "";
  if (tool === "unsent") { return [{ kind: "reasoning", content: note.length === 0 ? { kind: "empty" } : { kind: "text", text: note } }]; }
  if (callId === undefined || tool === undefined) { return []; }
  const input = stringOf(message.args);
  return [
    { kind: "tool_call_started", callId, tool, ...(input === undefined ? {} : { input }) },
    { kind: "tool_call_ended", callId, ...(note.length === 0 ? {} : { content: [{ type: "text", text: note }] }) },
  ];
}

function said(message: JsonRecord): readonly RuntimeEventBody[] {
  const text = typeof message.text === "string" ? message.text : "";
  const id = stringOf(message.id);
  if (message.who === "agent") { return [{ kind: "text_delta", text, ...(id === undefined ? {} : { messageId: id }) }]; }
  const inputId = stringOf(message.inputId);
  return [{ kind: "user_message", input: text, ...(inputId === undefined ? {} : { inputId }), ...(id === undefined ? {} : { nativeMessageId: id }), evidence: "conversation" }];
}

/** Read one line of `bottega serve` (bottega/src/serve.ts). A line this does not know still enters the stream, with no events. */
export function foldBottega(state: BottegaProjection, message: JsonRecord): BottegaFolded {
  const type = `bottega/${typeof message.type === "string" ? message.type : "line"}`;
  const frame = (events: readonly RuntimeEventBody[], next: BottegaProjection = state): BottegaFolded => ({ state: next, body: { type, native: message, events } });
  switch (message.type) {
    case "turn_started": {
      const inputId = stringOf(message.inputId);
      return frame([{ kind: "turn_active", ...(inputId === undefined ? {} : { inputId }) }], { ...state, turnOpen: true });
    }
    case "turn_ended": {
      const inputIds = Array.isArray(message.inputIds) ? message.inputIds.filter((id): id is string => typeof id === "string") : [];
      return frame([{ kind: "turn_ended", outcome: bottegaTurnOutcome(message), ...(inputIds.length === 0 ? {} : { inputIds }) }], { ...state, turnOpen: false });
    }
    case "said": return frame(said(message));
    case "action": return frame(action(message));
    case "step": {
      const folded = step(state, message);
      return frame(folded.events, folded.state);
    }
    case "input_dropped": {
      const inputId = stringOf(message.inputId);
      const reason = stringOf(message.reason);
      return frame(inputId === undefined ? [] : [{ kind: "input_dropped", reason: "runtime_refused", inputId, ...(reason === undefined ? {} : { message: reason }) }]);
    }
    default: return frame([]);
  }
}
