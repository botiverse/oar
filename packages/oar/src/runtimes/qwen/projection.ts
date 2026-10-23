import type { RuntimeEventBody, TokenTotals, TurnOutcome } from "../../contracts/session.js";
import { asNumber, asRecord, type JsonRecord } from "../../shared/json.js";
import { initialStreamJsonProjection, type StreamJsonProjectionState } from "../../shared/stream-json/state.js";
import type { StreamJsonProjectionProfile } from "../../shared/stream-json/profile.js";
import { cacheParts, noTokens } from "../../shared/token-totals.js";

export interface QwenProjection extends StreamJsonProjectionState {
  /** A new process can restore historical totals; no session-scoped baseline query exists in 0.26.0. */
  readonly usageKnown: boolean;
  readonly usage: TokenTotals;
}
export function initialQwenProjection(resume = false): QwenProjection {
  return { ...initialStreamJsonProjection, usageKnown: !resume, usage: noTokens };
}

/** Qwen result.usage is cumulative across the native conversation, cache reads already included. */
export function qwenUsage(message: JsonRecord): TokenTotals | null {
  const usage = asRecord(message.usage);
  const input = asNumber(usage?.input_tokens); const output = asNumber(usage?.output_tokens);
  if (usage === null || input === null || output === null) { return null; }
  return { input, output, ...cacheParts(usage, { read: "cache_read_input_tokens", write: "cache_creation_input_tokens" }) };
}

function outcome(state: QwenProjection, message: JsonRecord): TurnOutcome {
  if (state.abortRequested) { return { kind: "aborted" }; }
  if (message.is_error !== true) {
    return { kind: "completed", ...("structured_result" in message ? { structuredOutput: message.structured_result } : {}) };
  }
  const error = asRecord(message.error);
  return { kind: "failed", failure: message.subtype === "error_max_turns" ? "limit_reached" : "unknown",
    reason: typeof error?.message === "string" ? error.message : `Qwen result: ${String(message.subtype)}` };
}

export const qwenProjectionProfile: StreamJsonProjectionProfile<QwenProjection> = {
  name: "qwen", duplicateReason: "Qwen refused the input", commandLifecycle: false,
  assistant: (state) => state,
  result: (state, message, agentPath) => {
    const usage = agentPath.length === 0 && state.usageKnown ? qwenUsage(message) : null;
    const before: RuntimeEventBody[] = usage === null ? [] : [{ kind: "usage", usage: { total: usage } }];
    return { state: usage === null ? state : { ...state, usage }, outcome: outcome(state, message), before, after: [] };
  },
  init: () => [],
  compacted: (state) => state,
  system: (state) => ({ state, events: [] }),
  other: (state) => ({ state, events: [] }),
};
