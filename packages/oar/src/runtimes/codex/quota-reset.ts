import { asNumber, asRecord, type JsonRecord } from "../../shared/json.js";
import { utcInstantFromDate } from "../../shared/instant.js";
import type { UtcInstant } from "../../contracts/account-usage.js";

/** Account notifications name no thread. OAR owns one app-server per session;
 * once child activity appears, their ownership is no longer established. */
export interface CodexQuotaReset {
  readonly otherThreads: boolean;
  readonly turnId: string | null;
  readonly failed: boolean;
  readonly resetsAt: UtcInstant | null;
}

export const emptyCodexQuotaReset: CodexQuotaReset = { otherThreads: false, turnId: null, failed: false, resetsAt: null };

function exhaustedReset(params: JsonRecord): UtcInstant | null {
  const limits = asRecord(params.rateLimits);
  if (limits?.limitId !== "codex") { return null; }
  const exhausted = [asRecord(limits.primary), asRecord(limits.secondary)]
    .filter(window => (asNumber(window?.usedPercent) ?? 0) >= 100);
  const resets = exhausted.map(window => {
    const seconds = asNumber(window?.resetsAt);
    return seconds === null ? null : utcInstantFromDate(new Date(seconds * 1000));
  });
  // Different exhausted windows do not identify a single reset for this error.
  const first = resets[0] ?? null;
  return first !== null && resets.every(reset => reset === first) ? first : null;
}

export function nextCodexQuotaReset(state: CodexQuotaReset, root: string, method: string, params: JsonRecord): CodexQuotaReset {
  const item = asRecord(params.item);
  const threadId = params.threadId ?? asRecord(params.thread)?.id;
  if ((typeof threadId === "string" && threadId !== root)
    || item?.type === "collabAgentToolCall" || item?.type === "collabToolCall" || item?.type === "subAgentActivity") {
    return { ...emptyCodexQuotaReset, otherThreads: true };
  }
  if (state.otherThreads) { return state; }
  const id = asRecord(params.turn)?.id;
  if (method === "turn/started") {
    return { ...emptyCodexQuotaReset, turnId: typeof id === "string" ? id : null };
  }
  if (method === "turn/completed") { return emptyCodexQuotaReset; }
  if (method === "item/started" && item?.type === "contextCompaction") {
    return { ...state, resetsAt: null };
  }
  if (state.turnId === null || state.failed) { return state; }
  if (method === "account/rateLimits/updated") { return { ...state, resetsAt: exhaustedReset(params) }; }
  if (method === "error" && params.turnId === state.turnId && params.willRetry === false) { return { ...state, failed: true }; }
  return state;
}

/** Only the named quota error can consume a snapshot; a full window cannot classify a failure. */
export function codexQuotaResetForTurn(state: CodexQuotaReset, reporter: string, root: string, turn: JsonRecord | null): UtcInstant | null {
  return reporter === root && turn?.id === state.turnId && asRecord(turn.error)?.codexErrorInfo === "usageLimitExceeded"
    ? state.resetsAt : null;
}
