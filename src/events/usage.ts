/**
 * Token usage, normalised.
 *
 * Day-1 because usage is what an agent actually spends, and because vendors
 * report it in incompatible shapes. Leave it out of the contract and every
 * driver invents its own, so every consumer writes N adapters -- the exact
 * divergence this layer exists to absorb.
 *
 * ⚠️ THE TRAP, and the reason this file is not four numbers:
 *
 * Not every runtime reports every component. Give the record a plain
 * `cacheReadTokens: number` and a runtime that does not report caching writes
 * `0` -- which is **indistinguishable from a genuine zero**. A consumer then
 * sums it, charts it, and concludes caching is not working when in truth it was
 * never measured. That is the same false-presence shape as the cast that
 * motivated this project: a value asserted into existence where the source had
 * nothing to say.
 *
 * ⇒ So an unreported component is ABSENT, not zero. `exactOptionalPropertyTypes`
 * makes the distinction survive: you cannot pass `undefined` where a number is
 * expected, and you must handle absence at every read site.
 */

/**
 * One measurement. Every field is optional because every field is genuinely
 * unavailable on some runtime -- and `total` is not derived here, because
 * summing partial components would manufacture exactly the false number this
 * file exists to prevent.
 */
export interface TokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /** Reported by runtimes with prompt caching; absent elsewhere. */
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  /** Reasoning/thinking tokens, where the vendor separates them. */
  readonly reasoningTokens?: number;
}

/**
 * Scope must be explicit.
 *
 * "500 tokens" is meaningless without knowing whether it covers this turn or
 * the session so far. Vendors differ, some change between versions, and a
 * consumer that adds cumulative reports gets a number that grows quadratically
 * while looking plausible.
 */
export type UsageScope = "turn" | "session_cumulative";

export interface UsageReport {
  readonly scope: UsageScope;
  readonly usage: TokenUsage;
}

/**
 * Sum two reports of the SAME scope, preserving absence.
 *
 * A component absent from both stays absent. A component present in either is
 * summed treating the missing side as contributing nothing -- which is honest,
 * because the alternative is discarding a real measurement. What is never done
 * is inventing a zero for something nobody measured.
 */
export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  const out: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  } = {};
  const input = sum(left.inputTokens, right.inputTokens);
  if (input !== undefined) { out.inputTokens = input; }
  const output = sum(left.outputTokens, right.outputTokens);
  if (output !== undefined) { out.outputTokens = output; }
  const cacheRead = sum(left.cacheReadTokens, right.cacheReadTokens);
  if (cacheRead !== undefined) { out.cacheReadTokens = cacheRead; }
  const cacheWrite = sum(left.cacheWriteTokens, right.cacheWriteTokens);
  if (cacheWrite !== undefined) { out.cacheWriteTokens = cacheWrite; }
  const reasoning = sum(left.reasoningTokens, right.reasoningTokens);
  if (reasoning !== undefined) { out.reasoningTokens = reasoning; }
  return out;
}

/**
 * Absent on BOTH sides stays absent -- that is the whole point. Present on
 * either side sums, treating the missing side as contributing nothing, because
 * discarding a real measurement would be the worse error.
 */
function sum(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) {
    return undefined;
  }
  return (a ?? 0) + (b ?? 0);
}
