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

/** Stable reason codes; no credentials or provider response bodies are included. */
export type AccountUsageUnsupportedReason =
  | "capability_unavailable"
  | "unsupported_installation"
  | "unsupported_auth_mode"
  | "unsupported_auth_storage"
  | "auth_configuration_unavailable"
  | "endpoint_unavailable"
  | "quota_unavailable";

export type AccountUsageReauthReason =
  | "not_authenticated"
  | "credentials_missing"
  | "scope_missing"
  | "credentials_rejected";

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
  | {
      readonly kind: "reauth_required";
      /** Built-in readers always report a reason; optional for older adapters. */
      readonly reason?: AccountUsageReauthReason;
    }
  | {
      readonly kind: "unsupported";
      /** Unsupported for this installation/account does not imply missing capability. */
      readonly reason?: AccountUsageUnsupportedReason;
    };

export interface AccountUsageReadOptions {
  readonly timeoutMs?: number;
}

export type AccountUsageReader = (
  installation: AvailableInstallation,
  options?: AccountUsageReadOptions,
) => Promise<AccountUsageSnapshot>;
