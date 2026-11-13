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
  /**
   * What the runtime ties the window to. `account`: it reports the window as
   * the account's, not a model's. `models`: a group of models', by the
   * runtime's name for the group. `model`: one model's, by the runtime's own
   * name for it, kept as given (claude "Opus", "Fable"; codex's `limitName`,
   * "GPT-5.3-Codex-Spark" or a quota alias such as "gpt-reserve"); not
   * promised to equal a `listModels` id or display name, so a host matches it
   * to its own models. Omitted when the runtime says neither: unknown, not
   * the whole account.
   */
  readonly scope?: AccountUsageWindowScope;
}

export type AccountUsageWindowScope =
  | { readonly kind: "account" }
  | { readonly kind: "model"; readonly name: string }
  /** A group of models the runtime limits together, by its name for the group (antigravity "Gemini Models"). */
  | { readonly kind: "models"; readonly name: string };

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
  /**
   * Which reset to spend: an `id` from `limitResets.resets` (codex) or from
   * `inspectLimitResets` (claude, where it names a kind). Omitted lets codex
   * choose; claude requires it (`reset_id_required`).
   */
  readonly resetId?: string;
  /**
   * The person accepted that on Claude's older reset program, opening any
   * `/limit-reset` at the 5-hour limit spends the 5-hour reset with no
   * confirmation. Without it, claude does not open the command while usage
   * shows the 5-hour limit reached, or cannot rule it out; a `five_hour`
   * request is itself consent to spending the 5-hour reset and is not
   * checked. Codex ignores it.
   */
  readonly fiveHourLimitConsent?: boolean;
  /** Same overlay as sessions: strings override, null removes, and the host is untouched. */
  readonly env?: SessionOptions["env"];
  /**
   * Bounds the whole call, every process it starts included; each runtime
   * has its own default. Past it codex rejects; claude answers
   * `not_attempted` or `unknown` (a call still waiting for its single UI
   * session answers at once).
   */
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
  | { readonly kind: "unsupported"; readonly reason: LimitResetUnsupportedReason }
  /** Nothing was sent that could spend a reset; the same attempt may be made again. */
  | { readonly kind: "not_attempted"; readonly reason: Exclude<LimitResetNotAttemptedReason, "startup_failed"> }
  | LimitResetStartupFailed
  /**
   * The runtime may have spent a reset, and its answer was not seen (claude:
   * the command was submitted, or Yes was sent, and no recognised screen
   * followed). Never retried by oar.
   * `fiveHourSpent`: claude's older program spent its 5-hour reset instead
   * of the kind asked for.
   */
  | { readonly kind: "unknown"; readonly fiveHourSpent?: true };

/** Why a limit-reset call or inspection is not available here. */
export type LimitResetUnsupportedReason =
  | AccountUsageUnsupportedReason
  /** The operation cannot run here (claude: anywhere but Linux, or without the system `script`). */
  | "unsupported_platform"
  /** The installed CLI drew a screen oar does not recognise, or no version banner. */
  | "unsupported_version"
  /** Claude needs `resetId` naming a kind; a bare command can spend with no confirmation. */
  | "reset_id_required"
  /** Usage shows the 5-hour limit reached and `fiveHourLimitConsent` was not given. */
  | "consent_required";

/** Why nothing was attempted; nothing was spent. */
export type LimitResetNotAttemptedReason =
  /** Another limit-reset call held the runtime's single UI session and too many waited, or too little of this call's time was left when its turn came. */
  | "busy"
  /** The usage read right before the first command failed, so the 5-hour limit could not be ruled out. */
  | "usage_unread"
  /** Too little time was left to finish safely. */
  | "deadline"
  /** The CLI did not reach an empty prompt with a screen oar recognises; nothing was typed but the folder-trust answer. `startup` on the result says what was seen. */
  | "startup_failed";

/** `not_attempted` / `startup_failed`, with what was recognised on the way when the runtime says. */
export interface LimitResetStartupFailed {
  readonly kind: "not_attempted";
  readonly reason: "startup_failed";
  /** What oar last recognised before the CLI's UI failed to reach a usable prompt (claude); omitted when the runtime reports nothing. */
  readonly startup?: LimitResetStartupDiagnostic;
}

/**
 * oar's own classification of the last startup screen: UI chrome only, never
 * screen text (which can hold paths, an email, conversation text). `version`
 * is the banner's (`Claude Code v2.1.323`), when one was drawn.
 */
export interface LimitResetStartupDiagnostic { readonly screen: LimitResetStartupScreen; readonly version?: string }

/** Each value is described in docs/spec/account-usage.md (Claude limit resets). Values may be added: read one not listed here as `unknown`. */
export type LimitResetStartupScreen = "blank" | "exited" | "trust_unrecognised" | "dialog" | "prompt_with_text" | "no_banner" | "unsettled" | "unknown";

/** One kind of reset, as `inspectLimitResets` found it. */
export interface LimitResetKindStatus {
  /** The kind, for `LimitResetOptions.resetId` (claude: `five_hour`, `weekly`, `fable`, `full`). */
  readonly id: string;
  /**
   * `available`: held (and `resetsLeft` when the runtime showed a count).
   * `none`: not held. `not_offered`: the account's program has no such kind.
   * `unknown`: opened and not recognised. `not_checked`: not opened.
   */
  readonly state: "available" | "none" | "not_offered" | "unknown" | "not_checked";
  readonly resetsLeft?: number;
  /** The runtime's own words for when it expires ("use by Nov 19, 4:59pm"); it gives no instant. */
  readonly expiresText?: string;
}

export interface LimitResetInspectOptions {
  /** See `LimitResetOptions.fiveHourLimitConsent`. */
  readonly fiveHourLimitConsent?: boolean;
  /** Also open the 5-hour kind; otherwise it is `not_checked`. */
  readonly includeFiveHour?: boolean;
  /** Same overlay as sessions: strings override, null removes, and the host is untouched. */
  readonly env?: SessionOptions["env"];
  /** Bounds the whole call, every process it starts included; past it claude answers `not_attempted` or what it found so far. */
  readonly timeoutMs?: number;
}

export type LimitResetInspection =
  | {
      readonly kind: "inspected";
      /** Claude's older program (one 5-hour reset, no kinds) answered; it says nothing more. */
      readonly program?: "legacy";
      /** The older program spent its 5-hour reset when the command opened (only with consent). */
      readonly fiveHourSpent?: true;
      readonly resets: readonly LimitResetKindStatus[];
      /** The CLI version whose screens were read. */
      readonly version?: string;
    }
  | { readonly kind: "reauth_required"; readonly reason: AccountUsageReauthReason }
  | { readonly kind: "unsupported"; readonly reason: LimitResetUnsupportedReason }
  | { readonly kind: "not_attempted"; readonly reason: Exclude<LimitResetNotAttemptedReason, "startup_failed"> }
  | LimitResetStartupFailed
  /** The first screen after the command was not recognised; nothing more was typed. */
  | { readonly kind: "unknown" };

/**
 * Lists an account's limit resets by opening the runtime's own interactive
 * command and cancelling it (claude). Not a passive read: it starts the CLI's
 * UI, and on Claude's older program it can spend the 5-hour reset (see
 * `fiveHourLimitConsent`). Only on the account owner's explicit request; never
 * poll it. A call that launches the UI costs a model request: the UI sends
 * one at startup, reported to count as subscription usage and possibly to
 * start an idle account's 5-hour window (see `Runtime.inspectLimitResets`).
 */
export type LimitResetInspector = (
  installation: AvailableInstallation,
  options?: LimitResetInspectOptions,
) => Promise<LimitResetInspection>;

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
