/**
 * PROGRESS — per-subject, and deliberately NOT the same type as liveness.
 *
 * This file exists because of a production incident, and it encodes the exact
 * confusion that caused it.
 *
 * A shell command was started and then produced nothing for eight minutes. It
 * was never interrupted, because the supervisor's staleness check asked *is the
 * runtime process alive?* — and it was. Meanwhile a payload-free "still here"
 * signal kept refreshing a single shared progress clock, so the runtime looked
 * busy and healthy while the one item everybody cared about had not advanced at
 * all.
 *
 * Two distinct mistakes, both representable in a loosely typed design:
 *
 *   1. LIVENESS WAS READ AS PROGRESS. "The process exists" says nothing about
 *      whether any work advanced. A no-progress deadline built on aliveness can
 *      never fire on a hung-but-alive command — which is the only case it was
 *      built for.
 *   2. ONE SUBJECT'S SIGNAL REFRESHED ANOTHER'S CLOCK. Activity anywhere in the
 *      runtime renewed the deadline for a specific item. Cross-subject
 *      contamination turns "this item is stuck" into "something, somewhere, is
 *      happening".
 *
 * So progress here is (a) a different type from liveness, and (b) always bound
 * to the subject that advanced. Neither mistake can be written.
 */

/** What a progress observation is ABOUT. Progress is never global. */
export interface Subject {
  /** Stable id of the thing advancing -- a tool call, a turn, a launch. */
  readonly itemId: string;
  readonly kind: "tool_call" | "turn" | "launch";
}

/**
 * The runtime is still there. Deliberately carries NO subject and NO timestamp
 * usable as progress: it cannot be mistaken for, or substituted into, a
 * progress calculation, because it is a different type with no subject to
 * attach to.
 */
export interface Liveness {
  readonly kind: "liveness";
}

/** A named subject advanced. This — and only this — resets its deadline. */
export interface Progress {
  readonly kind: "progress";
  readonly subject: Subject;
  /**
   * Who observed the advance. An advance inferred by the host from indirect
   * activity is NOT authoritative: the incident's false progress came from a
   * payload-free signal being treated as evidence of work.
   */
  readonly emitter: "runtime";
}

/**
 * Staleness is asked PER SUBJECT, and the answer is three-valued.
 *
 * `unknown` exists because the alternative is to encode "no progress record"
 * as "no progress", which is the same absent-equals-negative error that made
 * the incident invisible. A supervisor must be able to distinguish *this item
 * has not advanced* from *this item is not instrumented*.
 */
export type Staleness =
  | { readonly kind: "advancing"; readonly sinceLastMs: number }
  | { readonly kind: "stalled"; readonly sinceLastMs: number }
  | { readonly kind: "unknown" };

/**
 * A deadline is expressed over ONE subject's progress. There is no overload
 * taking liveness, and no variant covering "the runtime" as a whole -- so
 * "the process is up, therefore the command is fine" has no way to be spelled.
 */
export interface NoProgressDeadline {
  readonly subject: Subject;
  readonly afterMs: number;
}

/**
 * Only a `Progress` for the SAME subject resets a deadline. Liveness is not
 * accepted, and neither is progress belonging to a different item.
 */
export function resets(deadline: NoProgressDeadline, event: Progress | Liveness): boolean {
  return event.kind === "progress" && event.subject.itemId === deadline.subject.itemId;
}
