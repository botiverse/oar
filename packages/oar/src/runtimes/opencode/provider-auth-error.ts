/**
 * Why an OpenCode provider-auth operation did not complete.
 *
 * - `version_unsupported`: the installation is OpenCode 1; provider sign-in needs OpenCode 2 (`@opencode/cli`).
 * - `unsupported_installation`: not a machine-installed `opencode` executable.
 * - `startup_failed`: `opencode serve` exited or never printed its address.
 * - `server_failed`: OpenCode's server stopped answering.
 * - `authentication_failed`: OpenCode's server answered 401 to OAR's password (something else answered on its port, or it ignored `OPENCODE_PASSWORD`).
 * - `timed_out`: OAR's deadline passed (startup, a request, or a sign-in the person did not finish).
 * - `unknown_provider`: OpenCode has no integration with that id.
 * - `method_unavailable`: the integration offers no such sign-in (no OAuth method, no key prompt, or `setApiKey` on a key that needs more answers).
 * - `rejected`: OpenCode refused the request or reported the sign-in `failed` (`status`, `tag` and its words when it gave them).
 * - `expired`: the sign-in attempt expired before the person finished it.
 * - `loopback_required`: with `loopback: "refuse"`, the OAuth attempt redirects its browser to a loopback address on the machine running `opencode serve` and takes no pasted code, so only a browser on that machine can finish it; the attempt was cancelled.
 */
export type OpencodeProviderAuthErrorKind =
  | "version_unsupported"
  | "unsupported_installation"
  | "startup_failed"
  | "server_failed"
  | "authentication_failed"
  | "timed_out"
  | "unknown_provider"
  | "method_unavailable"
  | "rejected"
  | "expired"
  | "loopback_required";

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
