import type { AvailableInstallation } from "./installation.js";
import type { ProviderLoginInteraction } from "./provider-auth.js";
import type { UtcInstant } from "./account-usage.js";

/** What the runtime says about the account it is signed in to. Every field is the runtime's own word, absent when it gives none. */
export interface LoginAccount {
  readonly email?: string;
  /** The runtime's plan or subscription label (`max`, `pro`, ...). */
  readonly plan?: string;
  /** The runtime's name for how it is signed in (`claude.ai`, `chatgpt`, `apiKey`, ...). */
  readonly method?: string;
  /**
   * When the stored sign-in stops working, as the runtime reports it: a
   * credential the runtime does not renew by itself (cursor's minted API
   * key), after which it is logged out until the next login.
   */
  readonly expiresAt?: UtcInstant;
}

/** Why a login ended without a logged-in runtime. */
export type LoginFailureReason =
  | "timed_out" // oar's deadline passed before the runtime reported success; the login process and everything it started were stopped
  | "rejected" // the runtime reported that the sign-in failed (`detail` carries its words)
  | "not_logged_in" // the runtime reported success, yet its own status query says logged out
  | "interaction_failed" // the caller's `prompt` or `onEvent` threw; the login process was stopped
  | "process_failed"; // the executable is no longer there (checked before anything is spawned), the login process could not start, or it ended without a result

/** Why oar cannot drive this runtime's login. */
export type LoginUnsupportedReason =
  | "unsupported_installation" // not the installation the runtime's login runs on (claude, codex: a machine-installed executable; cursor: the bundled SDK)
  | "version_unsupported"; // the installed version predates the login path oar drives (`detail` names the floor)

/**
 * How a login ended. `failed.detail` and `unsupported.detail` are for people:
 * one line in the runtime's own words where it gave one, with every pasted
 * code and token shape redacted.
 */
export type LoginResult =
  /** The runtime's own status query confirms the sign-in (or, when it cannot tell, the runtime reported success). */
  | { readonly kind: "logged_in"; readonly account?: LoginAccount }
  | { readonly kind: "failed"; readonly reason: LoginFailureReason; readonly detail?: string }
  /** `interaction.signal` aborted before the runtime reported success; the login process and everything it started were stopped. */
  | { readonly kind: "cancelled" }
  | { readonly kind: "unsupported"; readonly reason: LoginUnsupportedReason; readonly detail?: string };

export interface LoginOptions {
  /** Bound for the whole flow, the person's time in the browser included; each runtime has its own default. */
  readonly timeoutMs?: number;
}

/**
 * Signs the installation in through the runtime's own login, without a
 * terminal. Changes the machine's credentials: oar never calls it on its own.
 *
 * - Events go to `interaction.onEvent`: `auth_url` and `device_code` carry
 *   what a person opens or types, `info` the runtime's guidance. When the
 *   runtime needs a code pasted back, `interaction.prompt` is asked with
 *   `kind: "manual_code"`; the answer is written to the runtime's stdin only.
 * - Never: a token or a pasted code in an event, a result, an error or a log.
 * - Never logs the current account out first: a login that fails, times out
 *   or is cancelled leaves the previous login as it was.
 * - Aborting `interaction.signal` stops the login process with everything it
 *   started (an in-process SDK's login: its wait, and any write after it)
 *   and resolves `cancelled`. A prompt still open when the login
 *   settles is moot; the caller closes it.
 * - Once the runtime reports success it has stored the new login: a deadline
 *   or abort after that never yields `timed_out` or `cancelled`. The status
 *   query decides; when it cannot answer (it failed, or the caller aborted)
 *   the result is `logged_in` without an account.
 * - Logins are not serialized: whether two may run at once is the host's
 *   policy.
 */
export type RuntimeLogin = (
  installation: AvailableInstallation,
  interaction: ProviderLoginInteraction,
  options?: LoginOptions,
) => Promise<LoginResult>;

/**
 * Whether the runtime is logged in, from its own local status query.
 * `source` names the command (or SDK call) that answered.
 */
export type AuthStatus =
  | { readonly kind: "logged_in"; readonly account?: LoginAccount; readonly source: string }
  | { readonly kind: "logged_out"; readonly source: string }
  /** The status query failed or gave an answer oar cannot read; never a guess either way. */
  | { readonly kind: "unknown"; readonly detail?: string; readonly source?: string };

export interface AuthStatusOptions {
  readonly timeoutMs?: number;
}

/**
 * Cheap and read only: runs the runtime's local status query, never a login
 * flow, and returns no secret. Hosts call it to decide whether to offer a
 * login.
 */
export type AuthStatusReader = (
  installation: AvailableInstallation,
  options?: AuthStatusOptions,
) => Promise<AuthStatus>;
