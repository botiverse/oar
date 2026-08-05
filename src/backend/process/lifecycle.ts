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
  | { readonly kind: "exited"; readonly code: number; readonly diagnostic?: Diagnostic }
  | { readonly kind: "stalled"; readonly diagnostic: Diagnostic };

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
}
