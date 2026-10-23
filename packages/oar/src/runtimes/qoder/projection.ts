import type { RuntimeEventBody, TokenTotals, TurnOutcome } from "../../contracts/session.js";
import { asNumber, asRecord, type JsonRecord } from "../../shared/json.js";
import { initialStreamJsonProjection, type StreamJsonProjectionState } from "../../shared/stream-json/state.js";
import type { StreamJsonProjectionProfile } from "../../shared/stream-json/profile.js";
import { addTokens, cacheParts, noTokens } from "../../shared/token-totals.js";

export interface QoderProjection extends StreamJsonProjectionState {
  readonly usage: TokenTotals;
  readonly tokensExposed: boolean;
}
export function initialQoderProjection(tokensExposed = true): QoderProjection {
  return { ...initialStreamJsonProjection, usage: noTokens, tokensExposed };
}

/** Qoder reports the query's usage, not a conversation total. Its default wire format hides token counts. */
export function qoderUsage(message: JsonRecord): TokenTotals | null {
  const usage = asRecord(message.usage);
  const input = asNumber(usage?.input_tokens); const output = asNumber(usage?.output_tokens);
  if (usage === null || input === null || output === null) { return null; }
  const cache = cacheParts(usage, { read: "cache_read_input_tokens", write: "cache_creation_input_tokens" });
  return { input: input + (cache.cacheRead ?? 0) + (cache.cacheWrite ?? 0), output, ...cache };
}

function outcome(message: JsonRecord): TurnOutcome {
  if (message.terminal_reason === "aborted_streaming" || message.terminal_reason === "aborted_tools") { return { kind: "aborted" }; }
  if (message.is_error !== true) {
    return { kind: "completed", ...("structured_output" in message ? { structuredOutput: message.structured_output } : {}) };
  }
  const errors = Array.isArray(message.errors) ? message.errors.filter((entry): entry is string => typeof entry === "string") : [];
  const reason = errors.length > 0 ? errors.join("\n") : (typeof message.result === "string" ? message.result : `Qoder result: ${String(message.subtype)}`);
  return { kind: "failed", failure: message.error_code === 118 || message.error_code === "118" ? "billing"
    : (message.subtype === "error_max_turns" ? "limit_reached" : "unknown"), reason };
}

export const qoderProjectionProfile: StreamJsonProjectionProfile<QoderProjection> = {
  name: "qoder", duplicateReason: "Qoder refused the input", initStartsTurn: false, assistantAfterMessageStop: true, partialMessageIds: false,
  assistant: (state) => state,
  result: (state, message, agentPath) => {
    const report = state.tokensExposed && agentPath.length === 0 ? qoderUsage(message) : null;
    const usage = report === null ? state.usage : addTokens(state.usage, report);
    const before: RuntimeEventBody[] = report === null ? [] : [{ kind: "usage", usage: { total: usage } }];
    return { state: { ...state, usage }, outcome: outcome(message), before, after: [] };
  },
  init: () => [], compacted: (state) => state,
  system: (state) => ({ state, events: [] }), other: (state) => ({ state, events: [] }),
};
