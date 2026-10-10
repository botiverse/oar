import type { TokenTotals } from "../../contracts/session.js";
import { asNumber, asRecord, type JsonRecord } from "../../shared/json.js";
import { cacheParts } from "../../shared/token-totals.js";

/**
 * Grok injects these prompts directly into its session actor, outside ACP
 * session/prompt (spawn.rs::inject_subagent_completed_prompt). Their terminal
 * ledger is independent of RPC prompt ledgers. Never apply this to ordinary
 * turn_completed or child frames; the ACP recorder enforces root attribution.
 */
export function grokSpontaneousTokens(method: string, params: JsonRecord): { readonly key: string; readonly tokens: TokenTotals; readonly replayed?: boolean } | null {
  if (method !== "_x.ai/session_notification") { return null; }
  const update = asRecord(params.update);
  if (update?.sessionUpdate !== "turn_completed" || typeof update.prompt_id !== "string"
    || !update.prompt_id.startsWith("subagent-completed-") || update.prompt_id === "subagent-completed-") { return null; }
  // eventId is stable across duplicate delivery. A later wake of the same
  // resumed child can reuse the prompt id, but has a different native eventId.
  // oxlint-disable-next-line eslint/no-underscore-dangle -- Native ACP extension envelope.
  const meta = asRecord(params._meta);
  const key = meta?.eventId;
  const usage = asRecord(update.usage);
  const input = asNumber(usage?.inputTokens);
  const output = asNumber(usage?.outputTokens);
  if (typeof key !== "string" || key === "" || usage === null || input === null || output === null) { return null; }
  return { key, tokens: { input, output, ...cacheParts(usage, { read: "cachedReadTokens", write: "cacheCreationTokens" }) }, ...(meta?.isReplay === true ? { replayed: true } : {}) };
}
