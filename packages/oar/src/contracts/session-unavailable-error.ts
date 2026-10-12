/* oxlint-disable import/prefer-default-export -- the package exports names only. */
/**
 * Why a runtime keeps a resume target but will not open it now:
 * - `archived`: the user archived it in the runtime's own app; the host
 *   decides whether to unarchive it (OAR never does, since that reverses the
 *   user's own action).
 * - `in_use`: another process (for example the user's app) holds it; retry
 *   once that process lets go.
 */
export type SessionUnavailableReason = "archived" | "in_use";

/**
 * `session({ resume })` found the native conversation but the runtime will
 * not open it now. Only the documented runtime signals produce this error;
 * `message` keeps the runtime's own words. No turn exists yet: this is not a
 * FailureClass. See docs/spec/runtime-matrix.md#unavailable-resume-targets.
 */
export class SessionUnavailableError extends Error {
  override readonly name = "SessionUnavailableError";
  readonly sessionId: string;
  readonly reason: SessionUnavailableReason;
  declare readonly cause: { readonly method: string; readonly native: Readonly<Record<string, unknown>> };

  constructor(sessionId: string, message: string, details: { readonly reason: SessionUnavailableReason; readonly method: string; readonly native: Readonly<Record<string, unknown>> }) {
    super(message, { cause: { method: details.method, native: details.native } });
    this.sessionId = sessionId;
    this.reason = details.reason;
  }
}
