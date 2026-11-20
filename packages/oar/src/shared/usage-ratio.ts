/**
 * Shared `AccountUsageWindow.usedRatio` conversions.
 *
 * A ratio reaches `1` only when the runtime's native value says the quota is
 * exhausted: 6-decimal rounding never turns an unexhausted quota (such as
 * `99.99999%`) into `1`.
 */

const MAX_BELOW_ONE = 0.999999;

function roundBelowOne(raw: number): number {
  return Math.min(MAX_BELOW_ONE, Number(raw.toFixed(6)));
}

/** Convert a native used fraction (`0..1+`) to `usedRatio`, reaching `1` only at `raw >= 1`. */
export function usedRatioOf(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) { return 0; }
  if (raw >= 1) { return 1; }
  return roundBelowOne(raw);
}

/** Convert a native used percentage (`0..100+`) to `usedRatio`, reaching `1` only at `percent >= 100`. */
export function usedRatioFromPercent(percent: number): number {
  if (!Number.isFinite(percent) || percent <= 0) { return 0; }
  if (percent >= 100) { return 1; }
  return roundBelowOne(percent / 100);
}

/** Convert native `used` and `limit` counts to `usedRatio`, reaching `1` only when `used >= limit`. */
export function usedRatioFromCounts(used: number, limit: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0 || used <= 0) { return 0; }
  if (used >= limit) { return 1; }
  return roundBelowOne(used / limit);
}

/** Convert a native remaining fraction (`0..1`) to `usedRatio`, reaching `1` only when `remaining <= 0`. */
export function usedRatioFromRemaining(remaining: number): number {
  if (!Number.isFinite(remaining) || remaining >= 1) { return 0; }
  if (remaining <= 0) { return 1; }
  return roundBelowOne(1 - remaining);
}
