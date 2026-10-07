import type { RuntimeEventBody, TokenTotals } from "../../contracts/session.js";
import { asNumber, asRecord, type JsonRecord } from "../../shared/json.js";
import { cacheParts, noTokens, subtractTokens } from "../../shared/token-totals.js";

/*
 * codex's `thread/tokenUsage/updated` read as a `usage` event, and the
 * baseline that makes its totals count from when this Session opened (#169).
 * Pure: the projection fold (projection.ts) carries the baseline in its state.
 */

/**
 * Where the root thread's token count starts. codex's `total` spans the
 * thread's life: after a resume, before this Session's first turn starts,
 * codex re-reports it once, under the previous turn's id ([env] 0.151.0 and
 * later). A new thread counts from zero; a resumed one from that re-report.
 * A resumed thread whose first turn starts without one (codex before
 * 0.151.0) has no known start: don't know, don't report, so its totals are
 * left out of every later root usage event.
 */
export type CodexTokenBaseline =
  /** A resumed thread whose re-report may still come: none yet and no root turn started. */
  | { readonly kind: "awaiting" }
  /** Root totals count from `tokens`. */
  | { readonly kind: "known"; readonly tokens: TokenTotals }
  /** A resumed thread whose first turn started without a re-report. */
  | { readonly kind: "unknown" };

const fromZero: CodexTokenBaseline = { kind: "known", tokens: noTokens };

export function initialTokenBaseline(resumed: boolean): CodexTokenBaseline {
  return resumed ? { kind: "awaiting" } : fromZero;
}

/** What root totals count from; null when unknown (no `tokens` then). */
export function baselineTokens(baseline: CodexTokenBaseline): TokenTotals | null {
  return baseline.kind === "known" ? baseline.tokens : null;
}

/** codex's own running total in a `thread/tokenUsage/updated`; null when it carries none. */
function reportedTotal(params: JsonRecord): TokenTotals | null {
  const total = asRecord(asRecord(params.tokenUsage)?.total);
  const input = asNumber(total?.inputTokens);
  const output = asNumber(total?.outputTokens);
  if (total === null || input === null || output === null) {
    return null;
  }
  // `inputTokens` already counts the cache reads and writes; `cachedInputTokens`
  // and `cacheWriteInputTokens` are those parts (codex-api sse/responses.rs at
  // 4f39251a fills them from the Responses API's `input_tokens_details`
  // `cached_tokens` / `cache_write_tokens`). A build without the write field
  // reports no `cacheWrite`.
  return { input, output, ...cacheParts(total, { read: "cachedInputTokens", write: "cacheWriteInputTokens" }) };
}

/**
 * The baseline after one root-thread notification: while a resume awaits it,
 * the first root total is the re-report and becomes the baseline, and a root
 * `turn/started` arriving first leaves it unknown. Unchanged otherwise (the
 * same object).
 */
export function nextTokenBaseline(baseline: CodexTokenBaseline, method: string, params: JsonRecord): CodexTokenBaseline {
  if (baseline.kind !== "awaiting") {
    return baseline;
  }
  if (method === "turn/started") {
    return { kind: "unknown" };
  }
  const reported = method === "thread/tokenUsage/updated" ? reportedTotal(params) : null;
  return reported === null ? baseline : { kind: "known", tokens: reported };
}

/**
 * `tokenUsage.total` accumulates over every model call of the thread's life
 * (input 12.6k → 28.4k → 44.2k across three one-word turns, codex 0.154.0),
 * so it is the running spend, not what the context holds; less `baseline`
 * (the thread's total before this Session opened) it is this Session's
 * `tokens`, so the re-report itself reads zero, and with no known baseline
 * (null) there are no `tokens`. `tokenUsage.last` is the
 * most recent model call, and `modelContextWindow` the window it fit in;
 * those two are the context reading, whatever the baseline. Codex's own
 * occupancy figure is `last.total_tokens`
 * (`TokenUsage::tokens_in_context_window`, protocol.rs at 4f39251a; the
 * TUI's status card reads it off `last_token_usage`; its percent also
 * subtracts a 12k baseline). oar reads the same field, `last.totalTokens`:
 * the last call's input (cached tokens included) plus its output, which is
 * what the context holds once the reply is in, matching the runtime's own
 * reading rather than undercounting by the last output. When `last` is
 * absent (older builds) the occupancy is unknown: the cumulative input
 * stands in as `tokens` and the window and percent are null: the cumulative
 * total is never read against the window.
 */
export function codexUsageViews(params: JsonRecord, baseline: TokenTotals | null): RuntimeEventBody[] {
  const tokenUsage = asRecord(params.tokenUsage);
  const total = asRecord(tokenUsage?.total);
  if (total === null) {
    return [];
  }
  const input = asNumber(total.inputTokens);
  const reported = reportedTotal(params);
  const tokens = reported === null || baseline === null ? {} : { tokens: subtractTokens(reported, baseline) };
  const last = asRecord(tokenUsage?.last);
  if (last === null) {
    return [{ kind: "usage", usage: { context: { tokens: input, contextWindow: null, percent: null }, ...tokens } }];
  }
  const contextTokens = asNumber(last.totalTokens);
  const contextWindow = asNumber(tokenUsage?.modelContextWindow);
  const percent = contextTokens === null || contextWindow === null || contextWindow <= 0
    ? null
    : Math.round((contextTokens / contextWindow) * 100);
  return [{ kind: "usage", usage: { context: { tokens: contextTokens, contextWindow, percent }, ...tokens } }];
}
