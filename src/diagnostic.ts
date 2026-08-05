/**
 * A bounded, scrubbed, typed diagnostic.
 *
 * Process management is a utility for whoever IMPLEMENTS a driver, not a
 * surface consumers see: they get a session and typed events, never a process
 * and never a raw stderr pipe.
 *
 * The hazard that motivates this file: routing stderr to anywhere a user can
 * see it OPENS A CREDENTIAL-LEAK CHANNEL. In the extraction source that was a
 * live incident -- the scrubber covered bearer/API-key-shaped tokens, email,
 * URLs and paths, but not generic `KEY=value` env assignments.
 *
 * So the safe transformation is not documented, it is the only one available:
 * a `Diagnostic` cannot be constructed except by passing raw text through
 * `Diagnostic.fromRaw`, which bounds and scrubs it. An implementor needs no
 * memory to be safe and would have to work to bypass it.
 */

/** Closed set. Trace attributes carry these, never a raw excerpt. */
export type DiagnosticClass =
  | "launch_failed"
  | "credential_missing"
  | "crashed"
  | "stalled"
  | "protocol_violation"
  | "unknown";

const MAX_DETAIL_BYTES = 512;

/**
 * `KEY=value` env-assignment redaction -- the gap that leaked in production.
 * Kept first because it is the one a reviewer is least likely to think of.
 */
const REDACTIONS: readonly { readonly pattern: RegExp; readonly with: string }[] = [
  { pattern: /\b([A-Z][A-Z0-9_]{2,})=\S+/g, with: "$1=<redacted>" },
  { pattern: /\b(sk-|pk-|ghp_|xox[abps]-)[A-Za-z0-9._-]+/g, with: "<redacted-token>" },
  { pattern: /\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, with: "<redacted-email>" },
  { pattern: /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, with: "<redacted-url>" },
];

export class Diagnostic {
  private constructor(
    readonly errorClass: DiagnosticClass,
    /** Already bounded and scrubbed. There is no accessor for the original. */
    readonly detail: string,
    /** Present only when the runtime exited; absent for stalls. */
    readonly exitCode?: number,
  ) {}

  /**
   * The ONLY way to obtain a `Diagnostic`. Raw text goes in; nothing that
   * skipped scrubbing can come out, because no other constructor exists.
   */
  static fromRaw(
    diagnosticClass: DiagnosticClass,
    raw: string,
    exitCode?: number,
  ): Diagnostic {
    let scrubbed = raw;
    for (const redaction of REDACTIONS) {
      scrubbed = scrubbed.replace(redaction.pattern, redaction.with);
    }
    const bounded =
      scrubbed.length > MAX_DETAIL_BYTES
        ? `${scrubbed.slice(0, MAX_DETAIL_BYTES)}…`
        : scrubbed;
    return exitCode === undefined
      ? new Diagnostic(diagnosticClass, bounded)
      : new Diagnostic(diagnosticClass, bounded, exitCode);
  }
}
