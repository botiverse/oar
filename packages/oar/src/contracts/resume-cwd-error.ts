import { UnsupportedOptionError } from "./errors.js";

/** What the native directory check established, not whether history still exists. */
export type ResumeCwdReason = "not_listed" | "other_cwd" | "cwd_unreported" | "listing_unavailable";

type ResumeCwdDetails = {
  readonly sessionId: string;
  readonly requestedCwd: string;
} & (
  | { readonly reason: "other_cwd"; readonly savedCwd: string }
  | { readonly reason: Exclude<ResumeCwdReason, "other_cwd">; readonly savedCwd?: never }
);

/**
 * A resume could not honor or confirm the requested working directory.
 * Remains an UnsupportedOptionError on cwd. `not_listed` means only that
 * the completed native listing omitted the id, never that history is gone.
 * Native listing errors retain their own types instead of becoming this error.
 * See docs/runtimes/resume-cwd.md.
 */
export class ResumeCwdError extends UnsupportedOptionError {
  // Keeps the base name: hosts that recognize the refusal by `name` (for
  // example after serialization) must still see an UnsupportedOptionError.
  // Tell it apart with `instanceof ResumeCwdError` or its `reason`.
  readonly sessionId: string;
  readonly requestedCwd: string;
  readonly reason: ResumeCwdReason;
  declare readonly savedCwd?: string;

  // oxlint-disable-next-line unicorn/custom-error-definition -- The name stays the base class name on purpose (see above).
  constructor(message: string, details: ResumeCwdDetails) {
    super("cwd", message);
    this.sessionId = details.sessionId;
    this.requestedCwd = details.requestedCwd;
    this.reason = details.reason;
    if (details.reason === "other_cwd") { this.savedCwd = details.savedCwd; }
  }
}
