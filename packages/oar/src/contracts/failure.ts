/* oxlint-disable import/prefer-default-export -- the package exports names only. */
import type { UtcInstant } from "./account-usage.js";

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

/**
 * A failed turn's end (`TurnOutcome` `failed`), tagged by `failure`: a field
 * exists only on the failure it means something for, so a host checks
 * `failure` before reading it. `reason` is the runtime's own words; `status`
 * the provider's HTTP status, where the runtime reports one.
 */
export type FailedTurn =
  | {
    readonly kind: "failed";
    readonly failure: "auth";
    readonly reason: string;
    readonly status?: number;
    /** Where the runtime says which (docs/spec/runtime-matrix.md#the-mapping). */
    readonly credential?: CredentialProblem;
  }
  | {
    readonly kind: "failed";
    readonly failure: "quota";
    readonly reason: string;
    readonly status?: number;
    /**
     * When the limit resets, where the runtime reports that time for this
     * failure (claude's subscription limits; docs/spec/runtime-matrix.md#when-a-limit-resets).
     * Absent otherwise, never derived from an account-usage read or the
     * runtime's prose. It is the runtime's last report, which may be older
     * than the failure: a time already past means the host should treat the
     * reset as unknown. A fact, not a retry: oar does not continue the
     * session when it passes.
     */
    readonly resetsAt?: UtcInstant;
  }
  | {
    readonly kind: "failed";
    readonly failure: Exclude<FailureClass, "auth" | "quota">;
    readonly reason: string;
    readonly status?: number;
  };
