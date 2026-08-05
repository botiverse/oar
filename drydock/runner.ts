/**
 * The no-daemon entry point.
 *
 * ⚠️ NOTHING in this file may reference a daemon, server, agent id, or
 * credential broker. The single claim drydock exists to test is that a
 * consumer WITHOUT our daemon can drive a runtime; importing that world would
 * leave the claim looking tested while it no longer is.
 */
import type { IdleSession } from "../src/session/handle.js";
import type { RuntimeEvent } from "../src/events/event.js";

/**
 * A script is a plain list of steps, so a run is reproducible by reading it.
 * There is deliberately no "run arbitrary callback" step: a script that can do
 * anything cannot be replayed, and replay is the point.
 */
export type Step =
  | { readonly kind: "prompt"; readonly text: string }
  | { readonly kind: "await_turn_end" }
  | { readonly kind: "interrupt" }
  | { readonly kind: "stop"; readonly graceful: boolean };

export interface Script {
  readonly name: string;
  readonly steps: readonly Step[];
}

/**
 * A transcript is the recorded truth of one run.
 *
 * Recorded real behaviour is what makes deterministic replay meaningful: a
 * simulation only proves the state machine survives the interleavings it
 * simulates, so the grammar of what can happen has to come from observation
 * rather than from imagination. Otherwise exploration is thorough inside a
 * universe that does not exist.
 */
export interface Transcript {
  readonly script: string;
  readonly events: readonly RuntimeEvent[];
}

/**
 * What drydock needs in order to start a runtime. Note what is absent: no
 * host, no server, no identity. A command and an environment is the whole of
 * it -- and if that ever stops being enough, that fact is itself the finding.
 */
export interface RuntimeUnderTest {
  readonly id: string;
  start(): Promise<IdleSession>;
}
