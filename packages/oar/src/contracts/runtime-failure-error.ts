/* oxlint-disable import/prefer-default-export -- the package exports names only. */
import type { CredentialProblem, FailureClass } from "./session.js";

/**
 * What `session()` rejects with when the open fails for a cause a failed turn
 * would carry as `failure` (docs/spec/runtime-matrix.md#failure-evidence):
 * the runtime refused the login or the model before any turn. The same
 * `failure`, `credential` and `status` a failed turn has, so a host handles
 * both the same way (`failureAdvice`); `reason` (and `message`) is the
 * runtime's own words, or OAR's policy explanation when `code` is present.
 * Other open failures keep their own errors.
 */
/**
 * - `project_packages_blocked`: OAR's policy refused to install or replace Pi packages.
 * - `runtime_outdated`: the selected runtime is too old for what OAR needs; the reason names it and the first release that has it.
 * - `runtime_config_invalid`: the runtime could not read its own configuration; the reason is its words (for codex, the file, line and column).
 */
export type RuntimeFailureCode = "project_packages_blocked" | "runtime_outdated" | "runtime_config_invalid";

export class RuntimeFailureError extends Error {
  override readonly name = "RuntimeFailureError";
  readonly failure: FailureClass;
  /** Stable reason a host can branch on, separate from a missing session or cwd (`RuntimeFailureCode`). */
  declare readonly code?: RuntimeFailureCode;
  // Declared, not initialized: absent unless the runtime said them.
  declare readonly credential?: CredentialProblem;
  declare readonly status?: number;

  constructor(failure: FailureClass, reason: string, details: { readonly code?: RuntimeFailureCode; readonly credential?: CredentialProblem; readonly status?: number; readonly cause?: unknown } = {}) {
    super(reason, details.cause === undefined ? undefined : { cause: details.cause });
    this.failure = failure;
    if (details.code !== undefined) { this.code = details.code; }
    if (details.credential !== undefined) { this.credential = details.credential; }
    if (details.status !== undefined) { this.status = details.status; }
  }

  /** The explanation is the message itself, so redacting the message redacts it. */
  get reason(): string {
    return this.message;
  }
}
