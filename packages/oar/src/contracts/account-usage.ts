import type { AvailableInstallation } from "./installation.js";
import type { SessionOptions } from "./session-options.js";

declare const utcInstantBrand: unique symbol;

/**
 * An absolute UTC instant in the canonical ISO 8601 form produced by
 * `Date.prototype.toISOString()`, for example `2026-08-22T09:59:00.000Z`.
 * Build one with `utcInstantFromDate` (from `@botiverse/oar`), which returns
 * null for an invalid date; never cast a string to it.
 */
export type UtcInstant = string & { readonly [utcInstantBrand]: true };

export interface AccountUsageWindow {
  /** Human-readable, runtime-provided name of the usage bucket. */
  readonly label: string;
  /** Consumed fraction normalized to the inclusive range from 0 to 1. */
  readonly usedRatio: number;
  /** Next reset as a UTC instant; omitted when the runtime does not report one. */
  readonly resetsAt?: UtcInstant;
  /** The runtime's own key for this window, stable across reads (`label` is for display and may be reworded): key a time series by it. Omitted when the runtime names none. */
  readonly id?: string;
  /** The window's length in milliseconds, when the runtime reports it or its key names it; with `resetsAt` it places the window's start. Omitted otherwise. */
  readonly durationMs?: number;
}

/** One limit reset the account holds, as the runtime details it. */
export interface AccountLimitReset {
  /** The runtime's own identifier, for `LimitResetOptions.resetId`. */
  readonly id: string;
  /** The runtime's state for this reset; `unknown` when it reports a state it cannot name. */
  readonly status: "available" | "redeeming" | "redeemed" | "unknown";
  readonly grantedAt?: UtcInstant;
  /** Omitted when the reset does not expire. */
  readonly expiresAt?: UtcInstant;
  /** Runtime-provided display text; omitted when it gives none. */
  readonly title?: string;
  readonly description?: string;
}

/**
 * Resets the account can spend on its usage limits. `available` is the
 * runtime's count. `resets` is its detail list, which it may cap below
 * `available`; omitted when the runtime gave only the count, empty when it
 * looked and found none.
 */
export interface AccountLimitResets {
  readonly available: number;
  readonly resets?: readonly AccountLimitReset[];
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
      /**
       * Runtime-reported account display name (for example a profile nickname);
       * omitted when not exposed. Lets callers identify accounts that have no email.
       */
      readonly displayName?: string;
      readonly rateLimited: boolean;
      readonly windows: readonly AccountUsageWindow[];
      /** The account's limit resets, when the runtime reports them (codex); see `Runtime.redeemLimitReset`. */
      readonly limitResets?: AccountLimitResets;
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
  /** Same overlay as sessions: strings override, null removes, and the host is untouched. */
  readonly env?: SessionOptions["env"];
  /** Bounds the whole read, every process it starts and request it sends included; each reader has its own default. Past it the read rejects. */
  readonly timeoutMs?: number;
  /**
   * `false` asks only for the count of limit resets, without their detail
   * rows, for a host that polls (codex skips a backend lookup per read).
   * Default `true`. A runtime that reports no limit resets ignores it.
   */
  readonly limitResetDetails?: boolean;
}

export type AccountUsageReader = (
  installation: AvailableInstallation,
  options?: AccountUsageReadOptions,
) => Promise<AccountUsageSnapshot>;

export interface LimitResetOptions {
  /**
   * Names one attempt: a fresh unique value (a UUID) for each attempt, and
   * the same value when retrying it, so a retry never spends a second reset.
   * Required because only the caller can keep it across a retry.
   */
  readonly idempotencyKey: string;
  /** Which reset to spend, an `id` from `limitResets.resets`; omitted lets the runtime choose. */
  readonly resetId?: string;
  /** Same overlay as sessions: strings override, null removes, and the host is untouched. */
  readonly env?: SessionOptions["env"];
  /** Bounds the whole call, every process it starts included; each runtime has its own default. Past it the call rejects. */
  readonly timeoutMs?: number;
}

/**
 * How a redemption ended, as the runtime reports it. After any of the
 * available outcomes, read `accountUsage` again for the account's state;
 * none of them says what the limits are now.
 */
export type LimitResetResult =
  /** The runtime reset the account's limits and spent a reset. */
  | { readonly kind: "reset" }
  /** No limit needed resetting; no reset was spent. */
  | { readonly kind: "nothing_to_reset" }
  /** The account holds no reset to spend (or not the one `resetId` names). */
  | { readonly kind: "no_reset" }
  /** This attempt already went through: a retry with the key of an earlier call that reached the runtime. */
  | { readonly kind: "already_redeemed" }
  | { readonly kind: "reauth_required"; readonly reason: AccountUsageReauthReason }
  | { readonly kind: "unsupported"; readonly reason: AccountUsageUnsupportedReason };

/**
 * Spends one of the account's limit resets through the runtime's own call.
 * It uses up the account owner's reset, so oar never calls it on its own.
 * A rejection (timeout, network, malformed answer) leaves unknown whether
 * the reset was spent: retry with the same `idempotencyKey`.
 */
export type LimitResetRedeemer = (
  installation: AvailableInstallation,
  options: LimitResetOptions,
) => Promise<LimitResetResult>;
