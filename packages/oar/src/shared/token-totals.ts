import type { TokenTotals } from "../contracts/session.js";
import { asNumber, type JsonRecord } from "./json.js";

/** Nothing reported yet: the start of every running total. */
export const noTokens: TokenTotals = { input: 0, output: 0 };

function sumPart(previous: number | undefined, report: number | undefined): number | undefined {
  return previous === undefined && report === undefined ? undefined : (previous ?? 0) + (report ?? 0);
}

/**
 * `previous` plus one report's counts: an adapter folding a frame's own
 * usage into its running total, or a fold summing agents into the session
 * total. `cacheRead` / `cacheWrite` add like `input` but exist only once a
 * report carried them: a report without one adds nothing to it, and one that
 * has appeared stays (TokenTotals in contracts/records.ts).
 */
export function addTokens(previous: TokenTotals, report: TokenTotals): TokenTotals {
  const cacheRead = sumPart(previous.cacheRead, report.cacheRead);
  const cacheWrite = sumPart(previous.cacheWrite, report.cacheWrite);
  return {
    input: previous.input + report.input,
    output: previous.output + report.output,
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}

/**
 * The cache parts a native usage record reports, read from the runtime's own
 * field names: a field the record lacks (or that is not a number) stays
 * absent, never a guessed 0.
 */
export function cacheParts(usage: JsonRecord, fields: { readonly read: string; readonly write: string }): Pick<TokenTotals, "cacheRead" | "cacheWrite"> {
  const cacheRead = asNumber(usage[fields.read]);
  const cacheWrite = asNumber(usage[fields.write]);
  return {
    ...(cacheRead === null ? {} : { cacheRead }),
    ...(cacheWrite === null ? {} : { cacheWrite }),
  };
}
