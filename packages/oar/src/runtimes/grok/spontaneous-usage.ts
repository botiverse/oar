import type { TokenTotals } from "../../contracts/session.js";
import { asNumber, asRecord, type JsonRecord } from "../../shared/json.js";
import { cacheParts, reasoningPart } from "../../shared/token-totals.js";

/**
 * The ledger of a turn Grok ran on its own: a prompt OAR did not send (a
 * sub-agent's completion wake, spawn.rs::inject_subagent_completed_prompt; a
 * late interjection; native-turns.ts). Its terminal ledger is independent of
 * RPC prompt ledgers, which carry OAR's own prompts. The ACP recorder enforces
 * root attribution; child frames never reach this.
 */
export function grokSpontaneousTokens(method: string, params: JsonRecord, sentByOar: (promptId: string) => boolean = () => false): { readonly key: string; readonly tokens: TokenTotals; readonly replayed?: boolean } | null {
  if (method !== "_x.ai/session_notification") { return null; }
  const update = asRecord(params.update);
  if (update?.sessionUpdate !== "turn_completed" || typeof update.prompt_id !== "string"
    || update.prompt_id === "" || sentByOar(update.prompt_id)) { return null; }
  // eventId is stable across duplicate delivery. A later wake of the same
  // resumed child can reuse the prompt id, but has a different native eventId.
  // oxlint-disable-next-line eslint/no-underscore-dangle -- Native ACP extension envelope.
  const meta = asRecord(params._meta);
  const key = meta?.eventId;
  const usage = asRecord(update.usage);
  const input = asNumber(usage?.inputTokens);
  const output = asNumber(usage?.outputTokens);
  if (typeof key !== "string" || key === "" || usage === null || input === null || output === null) { return null; }
  return { key, tokens: { input, output, ...cacheParts(usage, { read: "cachedReadTokens", write: "cacheCreationTokens" }), ...reasoningPart(usage, "reasoningTokens") }, ...(meta?.isReplay === true ? { replayed: true } : {}) };
}
