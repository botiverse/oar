import type { UtcInstant } from "../contracts/account-usage.js";

/** Validate and serialize a Date as the public UTC-instant representation. */
export function utcInstantFromDate(value: Date): UtcInstant | null;
export function utcInstantFromDate(value: Date): string | null {
  return Number.isFinite(value.getTime()) ? value.toISOString() : null;
}
