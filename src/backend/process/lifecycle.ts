/**
 * Shared child-process management. THE OS AXIS, WRITTEN ONCE.
 *
 * Two axes are orthogonal and must not be allowed to multiply:
 *
 *   Windows / POSIX          -- OS axis      -> this file, shared by every driver
 *   claude / pi / codex ...  -- runtime axis -> per-driver
 *
 * Let the OS axis leak into the runtime adapters and you get 13 x 2 hand-written
 * combinations, each slightly different. In the extraction source that is
 * already happening: 14 driver files spawn a child, and 2 import the shared
 * Windows env helper. The helper is CORRECT; it is simply bypassable.
 *
 * ⇒ The lesson is not "should this be shared" but "sharing is worthless unless
 * it is the ONLY path". Whether an abstraction is right is secondary; whether
 * it can be bypassed is decisive. A library IS its enforcement boundary.
 *
 * This is an IMPLEMENTOR utility. Consumers never see it -- the contract they
 * hold is over a session, not a process, because some runtimes have no child
 * process at all (an in-process SDK has nothing to kill).
 */
import type { Diagnostic } from "../../events/diagnostic.js";

/** Intent, never mechanism. No signal names cross this boundary. */
export type StopIntent =
  /** Ask it to finish and go away. */
  | { readonly kind: "graceful"; readonly waitMs: number }
  /** Stop now. How that is achieved is the platform's business. */
  | { readonly kind: "immediate" };

export interface LaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
  /**
   * Per-runtime isolation (its own HOME / config dir) so credentials and
   * config from two runtimes cannot collide. Declared by the runtime; applied
   * here.
   */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * `exited` carries a code; `stalled` deliberately cannot, because a stall has
 * no exit code and a field that is meaningless half the time invites readers
 * to infer one.
 */
export type ProcessOutcome =
  | {
      readonly kind: "exited";
      readonly code: number;
      readonly tree: TreeCleanup;
      readonly diagnostic?: Diagnostic;
    }
  | { readonly kind: "stalled"; readonly tree: TreeCleanup; readonly diagnostic: Diagnostic };

/**
 * STOPPING IS A PROPERTY OF A PROCESS TREE, NOT OF ONE PROCESS.
 *
 * From a live upstream defect: after the parent command exits or times out, its
 * DESCENDANTS keep holding the stdout/stderr handles, so the runtime never sees
 * EOF and the turn hangs forever. Build, test and compiler commands are the
 * common triggers — exactly the shape of the reported incident.
 *
 * ⇒ So an outcome that reports only the parent's exit code is not merely
 * incomplete, it is misleading: recovery can restart the model loop while
 * leaving orphans that keep consuming resources and can contaminate the next
 * session.
 *
 * `unknown` is mandatory and must NOT be read as success. Where the underlying
 * runtime cannot prove the tree is clean, recovery degrades to
 * *unproven* rather than claiming a cleanup it did not observe — the same rule
 * as everywhere else here: an unmeasured thing must not be reported as a
 * measured absence.
 */
export type TreeCleanup =
  /** Every descendant of the launch is observed gone. */
  | { readonly kind: "cleaned" }
  /** Descendants observed still alive — recovery did NOT fully succeed. */
  | { readonly kind: "orphans_observed"; readonly count: number }
  /**
   * The platform or runtime gives no way to enumerate descendants here.
   * ⚠️ Not a success. A caller must treat this as recovery of unknown outcome.
   */
  | { readonly kind: "unknown" };

/**
 * What a platform backend implements. Adding Windows means adding one of
 * these, not touching any driver.
 */
export interface ProcessHost {
  spawn(spec: LaunchSpec): Promise<ProcessHandle>;
}

export interface ProcessHandle {
  stop(intent: StopIntent): Promise<ProcessOutcome>;
  /**
   * Raw stderr is consumed HERE and converted to a bounded, scrubbed
   * Diagnostic. There is no accessor returning the raw stream: routing stderr
   * to anywhere user-visible opens a credential-leak channel, and in the
   * extraction source the scrubber missed `KEY=value` env assignments. Making
   * the safe transformation the only available one beats documenting it.
   */
  drainDiagnostics(): AsyncIterable<Diagnostic>;
  /** The protocol channel (stdin/stdout). See `Transport`. */
  readonly transport: Transport;
}

/**
 * The PROTOCOL transport of a spawned runtime: stdin (send) + stdout (frames).
 *
 * This is stdout — the channel a runtime talks its own protocol over — NOT
 * stderr. stderr is credential-shaped and is only ever surfaced as a scrubbed
 * Diagnostic through `drainDiagnostics()`; it deliberately has no raw accessor.
 * stdout is the legitimate protocol channel, so exposing it here does not
 * reopen the leak the scrubber exists to close.
 */
export interface Transport {
  /** Write one newline-delimited frame to the runtime's stdin. */
  send(line: string): void;
  /** Newline-delimited frames from the runtime's stdout, in arrival order. */
  lines(): AsyncIterable<string>;
}
