/* oxlint-disable import/prefer-default-export -- the package exports names only. */
/**
 * `session({ resume })` could not find the requested native conversation.
 * Only the documented runtime signals produce this error; other failed
 * opens keep their own errors. For per-cwd stores, missing means missing
 * for the supplied cwd, so hosts should reuse the cwd they saved with the id.
 * No turn exists yet: this is not a FailureClass.
 * See docs/spec/runtime-matrix.md#missing-resume-targets.
 */
export class SessionNotFoundError extends Error {
  override readonly name = "SessionNotFoundError";
  readonly sessionId: string;
  declare readonly cause: { readonly method: string; readonly native: Readonly<Record<string, unknown>> };

  constructor(sessionId: string, message: string, cause: { readonly method: string; readonly native: Readonly<Record<string, unknown>> }) {
    super(message, { cause });
    this.sessionId = sessionId;
  }
}
