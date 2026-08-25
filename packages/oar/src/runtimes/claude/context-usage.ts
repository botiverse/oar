import type { ContextUsage } from "../../contracts/session.js";
import { asNumber, asRecord, type JsonRecord } from "../../shared/json.js";

/**
 * Claude reports context usage in the result frame (structured — no need for
 * the human-facing /context command): usage.{input,cache_read,cache_creation}
 * tokens are the context sent, and modelUsage[model].contextWindow is the
 * window. We cache the latest as the current snapshot (last-write-wins).
 */
export function claudeContextUsageFromResult(message: JsonRecord): ContextUsage | null {
  const usage = asRecord(message.usage);
  if (usage === null) {
    return null;
  }
  const input = asNumber(usage.input_tokens) ?? 0;
  const cacheRead = asNumber(usage.cache_read_input_tokens) ?? 0;
  const cacheCreate = asNumber(usage.cache_creation_input_tokens) ?? 0;
  const tokens = input + cacheRead + cacheCreate;
  const modelUsage = asRecord(message.modelUsage);
  const firstModel = modelUsage === null ? null : asRecord(Object.values(modelUsage)[0]);
  const contextWindow = firstModel === null ? null : asNumber(firstModel.contextWindow) ?? null;
  const percent = contextWindow === null || contextWindow === 0 ? null : Math.round((tokens / contextWindow) * 100);
  return { tokens, contextWindow, percent };
}
