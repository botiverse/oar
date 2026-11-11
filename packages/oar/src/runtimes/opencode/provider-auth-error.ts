/**
 * Why an OpenCode provider-auth operation did not complete.
 *
 * - `version_unsupported`: the installation is OpenCode 1; provider sign-in needs OpenCode 2 (`@opencode/cli`).
 * - `unsupported_installation`: not a machine-installed `opencode` executable.
 * - `startup_failed`: `opencode serve` exited or never printed its address.
 * - `server_failed`: OpenCode's server stopped answering.
 * - `timed_out`: OAR's deadline passed (startup, a request, or a sign-in the person did not finish).
 * - `unknown_provider`: OpenCode has no integration with that id.
 * - `method_unavailable`: the integration offers no such sign-in (no OAuth method, no key prompt, or `setApiKey` on a key that needs more answers).
 * - `rejected`: OpenCode refused the request or reported the sign-in `failed` (`status`, `tag` and its words when it gave them).
 * - `expired`: the sign-in attempt expired before the person finished it.
 */
export type OpencodeProviderAuthErrorKind =
  | "version_unsupported"
  | "unsupported_installation"
  | "startup_failed"
  | "server_failed"
  | "timed_out"
  | "unknown_provider"
  | "method_unavailable"
  | "rejected"
  | "expired";

/** The message carries OpenCode's own words, redacted; never a key, a pasted code or a token. */
export class OpencodeProviderAuthError extends Error {
  override readonly name = "OpencodeProviderAuthError";
  readonly kind: OpencodeProviderAuthErrorKind;
  /** OpenCode's HTTP status, when it answered. */
  readonly status: number | undefined;

  constructor(kind: OpencodeProviderAuthErrorKind, message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}
