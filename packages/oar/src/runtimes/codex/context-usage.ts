import type { ContextUsage } from "../../contracts/session.js";
import { asNumber, asRecord, type JsonRecord } from "../../shared/json.js";

/**
 * Codex reports usage in the streaming thread/tokenUsage/updated notification
 * (cumulative). `total.inputTokens` is the context sent; codex does NOT
 * include the context window in this event, so contextWindow/percent stay
 * null unless a future field carries it. We cache the latest (last-wins).
 */
export function codexContextUsageFromNotification(params: JsonRecord): ContextUsage | null {
  const total = asRecord(asRecord(params.tokenUsage)?.total);
  if (total === null) {
    return null;
  }
  const tokens = asNumber(total.inputTokens);
  return { tokens: tokens ?? null, contextWindow: null, percent: null };
}
