/* oxlint-disable import/prefer-default-export -- the package exports names only. */
/**
 * Coarse failure classification so applications can react (re-login, back
 * off, report a bug) without parsing vendor error prose. Adapters map what the
 * runtime reveals, its structured fields first (docs/spec/runtime-matrix.md#failure-evidence);
 * "unknown" is an honest answer. `failureAdvice` (observe) turns a class into
 * one retry policy for every host.
 * - `auth`: not signed in, or the credentials were rejected (`credential` says which, when the runtime does).
 * - `quota`: a usage or plan limit, until it resets.
 * - `rate_limited`: short-term throttling.
 * - `billing`: payment or credits.
 * - `model_unavailable`: the selected model cannot be used here (unknown, not entitled, not enabled).
 * - `input_too_large`: the context window or the payload was exceeded.
 * - `invalid_request`: the provider rejected the request itself.
 * - `overloaded`: the provider is temporarily overloaded.
 * - `provider`: another provider-side error (a 5xx).
 * - `runtime_exited`: the runtime process ended before the turn did.
 *
 * A failed turn a limit refused carries `resetsAt` when the runtime reports
 * when that limit resets (claude's subscription limits, `quota`).
 */
export type FailureClass =
  | "auth"
  | "quota"
  | "rate_limited"
  | "billing"
  | "model_unavailable"
  | "input_too_large"
  | "invalid_request"
  | "overloaded"
  | "provider"
  | "runtime_exited"
  | "unknown";

/** Which `auth` failure it is, set only where the runtime makes it plain: no credential at all, or one the provider refused. */
export type CredentialProblem = "missing" | "rejected";
