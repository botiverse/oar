/* oxlint-disable import/prefer-default-export -- the package exports names only. */
import type { CredentialProblem, FailureClass } from "./session.js";

/**
 * What `session()` rejects with when the open fails for a cause a failed turn
 * would carry as `failure` (docs/spec/runtime-matrix.md#failure-evidence):
 * the runtime refused the login or the model before any turn. The same
 * `failure`, `credential` and `status` a failed turn has, so a host handles
 * both the same way (`failureAdvice`); `reason` (and `message`) is the
 * runtime's own words. Other open failures keep their own errors.
 */
export class RuntimeFailureError extends Error {
  override readonly name = "RuntimeFailureError";
  readonly failure: FailureClass;
  // Declared, not initialized: absent unless the runtime said them.
  declare readonly credential?: CredentialProblem;
  declare readonly status?: number;
  readonly reason: string;

  constructor(failure: FailureClass, reason: string, details: { readonly credential?: CredentialProblem; readonly status?: number; readonly cause?: unknown } = {}) {
    super(reason, details.cause === undefined ? undefined : { cause: details.cause });
    this.failure = failure;
    this.reason = reason;
    if (details.credential !== undefined) { this.credential = details.credential; }
    if (details.status !== undefined) { this.status = details.status; }
  }
}
