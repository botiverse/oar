import type { Capabilities } from "../capability.js";
import type { RuntimeEvent } from "../events/event.js";

/**
 * State lives in the type, not in a runtime check.
 *
 * A handle that is mid-turn does not offer the operations that are illegal
 * mid-turn. "Prompted while busy" therefore stops being a case to test and
 * becomes a program that does not compile.
 *
 * The contract is expressed over a SESSION, never a process. Some runtimes are
 * not child processes at all (an in-process SDK has nothing to kill), so a
 * process-shaped contract could not express them. It also states INTENT rather
 * than MECHANISM -- `stop({ mode: "graceful" })`, never `sendSignal(SIGTERM)`.
 * Signals have no Windows equivalent; bake one into the contract and adding a
 * platform later means changing the contract, which is the most expensive
 * change a library has.
 */

export type StopMode = "graceful" | "immediate";

interface SessionBase {
  readonly capabilities: Capabilities;
  /** Events observed so far are delivered here regardless of state. */
  events(): AsyncIterable<RuntimeEvent>;
  stop(opts: { readonly mode: StopMode }): Promise<ClosedSession>;
}

/** Accepts work. */
export interface IdleSession extends SessionBase {
  readonly state: "idle";
  prompt(text: string): Promise<BusySession>;
}

/**
 * A turn is in flight. Note what is ABSENT: no `prompt`. Delivering a fresh
 * prompt mid-turn is not a runtime error to detect, it is unrepresentable.
 */
export interface BusySession extends SessionBase {
  readonly state: "busy";
  /** Only present after a capability check -- see `steerable`. */
  interrupt(): Promise<IdleSession>;
}

/** A busy session on a runtime that has been confirmed to support steering. */
export interface SteerableSession extends BusySession {
  steer(text: string): Promise<BusySession>;
}

export interface ClosedSession {
  readonly state: "closed";
  /** Absent on a clean stop; present when the runtime died on its own. */
  readonly diagnostic?: import("../events/diagnostic.js").Diagnostic;
}

export type Session = IdleSession | BusySession | ClosedSession;

/**
 * Capability flags NARROW types rather than merely documenting what to skip.
 *
 * Steering is resolved at runtime (it can depend on version), so it cannot be
 * gated statically. This turns the flag check into the only way to reach
 * `steer`: a caller who skips the check has no method to call.
 */
export function steerable(session: BusySession): SteerableSession | null {
  return session.capabilities.steer && hasSteer(session) ? session : null;
}

/**
 * A type predicate, so narrowing happens without an assertion. Casts are
 * banned on this boundary: a cast is an unchecked claim that silences the very
 * checker that would have caught it, and the production crash that motivated
 * this project was exactly one such cast erasing an optional field.
 */
function hasSteer(session: BusySession): session is SteerableSession {
  return typeof Reflect.get(session, "steer") === "function";
}
