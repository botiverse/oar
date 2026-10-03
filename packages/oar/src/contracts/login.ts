import type { AvailableInstallation } from "./installation.js";
import type { ProviderLoginInteraction } from "./provider-auth.js";

/** What the runtime says about the account it is signed in to. Every field is the runtime's own word, absent when it gives none. */
export interface LoginAccount {
  readonly email?: string;
  /** The runtime's plan or subscription label (`max`, `pro`, ...). */
  readonly plan?: string;
  /** The runtime's name for how it is signed in (`claude.ai`, `chatgpt`, `apiKey`, ...). */
  readonly method?: string;
}

/** Why a login ended without a signed-in runtime. */
export type LoginFailureReason =
  | "busy" // another login for this runtime is running in this process; nothing was started
  | "timed_out" // oar's deadline passed; the login process and everything it started were stopped
  | "rejected" // the runtime reported that the sign-in failed (`detail` carries its words)
  | "not_signed_in" // the runtime reported success, yet its own status query says signed out
  | "interaction_failed" // the caller's `prompt` or `onEvent` threw; the login process was stopped
  | "process_failed"; // the login process could not start, or ended without a result

/** Why oar cannot drive this runtime's login. */
export type LoginUnsupportedReason =
  | "unsupported_installation" // not a machine-installed executable
  | "version_unsupported" // the installed version predates the login path oar drives (`detail` names the floor)
  | "terms_of_service"; // the runtime's terms do not allow signing in through a third-party tool

/**
 * How a login ended. `failed.detail` and `unsupported.detail` are for people:
 * the runtime's own words with every pasted code and token shape redacted.
 */
export type LoginResult =
  /** The runtime's own status query confirms the sign-in (or, when it cannot tell, the runtime reported success). */
  | { readonly kind: "logged_in"; readonly account?: LoginAccount }
  | { readonly kind: "failed"; readonly reason: LoginFailureReason; readonly detail?: string }
  /** `interaction.signal` aborted; the login process and everything it started were stopped. */
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
 * - Never: a token or a pasted code in an event, a result or an error.
 * - Never signs the current account out first: a login that fails or is
 *   cancelled leaves the previous sign-in as it was.
 * - Aborting `interaction.signal` stops the login process with everything it
 *   started and resolves `cancelled`. A prompt still open when the login
 *   settles is moot; the caller closes it.
 * - One login per runtime at a time in this process; a second resolves
 *   `failed` with `busy`.
 */
export type RuntimeLogin = (
  installation: AvailableInstallation,
  interaction: ProviderLoginInteraction,
  options?: LoginOptions,
) => Promise<LoginResult>;

/**
 * Whether the runtime is signed in, from its own local status query.
 * `source` names the command that answered.
 */
export type AuthStatus =
  | { readonly kind: "signed_in"; readonly account?: LoginAccount; readonly source: string }
  | { readonly kind: "signed_out"; readonly source: string }
  /** The status query failed or gave an answer oar cannot read; never a guess either way. */
  | { readonly kind: "unknown"; readonly detail?: string; readonly source?: string };

export interface AuthStatusOptions {
  readonly timeoutMs?: number;
}

/**
 * Cheap and read only: runs the runtime's local status query, never a login
 * flow, and returns no secret. Hosts call it to decide whether to offer a
 * sign-in.
 */
export type AuthStatusReader = (
  installation: AvailableInstallation,
  options?: AuthStatusOptions,
) => Promise<AuthStatus>;
