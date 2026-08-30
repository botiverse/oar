import type { AvailableInstallation } from "./installation.js";

declare const utcInstantBrand: unique symbol;

/**
 * An absolute UTC instant in the canonical ISO 8601 form produced by
 * `Date.prototype.toISOString()`, for example `2026-08-22T09:59:00.000Z`.
 */
export type UtcInstant = string & { readonly [utcInstantBrand]: true };

export interface AccountUsageWindow {
  /** Human-readable, runtime-provided name of the usage bucket. */
  readonly label: string;
  /** Consumed fraction normalized to the inclusive range from 0 to 1. */
  readonly usedRatio: number;
  /** Next reset as a UTC instant; omitted when the runtime does not report one. */
  readonly resetsAt?: UtcInstant;
}

export type AccountUsageSnapshot =
  | {
      readonly kind: "available";
      /** Runtime-reported subscription plan or tier; omitted when not exposed. */
      readonly plan?: string;
      /** Signed-in account email; omitted when the runtime does not expose one. */
      readonly email?: string;
      readonly rateLimited: boolean;
      readonly windows: readonly AccountUsageWindow[];
    }
  | { readonly kind: "reauth_required" }
  | { readonly kind: "unsupported" };

export interface AccountUsageReadOptions {
  readonly timeoutMs?: number;
}

export type AccountUsageReader = (
  installation: AvailableInstallation,
  options?: AccountUsageReadOptions,
) => Promise<AccountUsageSnapshot>;
