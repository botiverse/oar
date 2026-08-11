/**
 * Status is a projection of the event stream — `status = fold(events)`.
 *
 * There is no `set_status`: a runtime emits events; the consumer folds them.
 * An independently-set status can silently disagree with the events (says idle
 * while a tool_call is open); a derived one cannot drift, because it is
 * recomputed from the facts. So this fold — not a status enum — is the contract.
 *
 * Compatibility premise (see ARCHITECTURE.md "Compatibility"): oar's own API may
 * break freely — its users are developers who upgrade fast. The real constraint
 * is that a *live fleet* runs a spread of versions at once (raft's daemons ship
 * to user machines and cannot all update instantly), so a consumer meets events
 * from producers of neighbouring versions. Two layers, deliberately separate:
 *   - in-process type layer: the `RuntimeEvent` union is closed and the `never`
 *     default below is the compile-time exhaustiveness tooth.
 *   - wire layer: an event from a different-version producer may carry a kind
 *     this build does not know. It degrades to `opaque` — never crash, never
 *     silently drop. `isKnownEventKind` is the guard the wire deserialiser uses.
 */
import type { Diagnostic } from "./diagnostic.js";
import type { RuntimeEvent } from "./event.js";

/** Turn-level status — a pure fold of the turn event stream. */
export type TurnStatus =
  | "idle" // no active turn: at the start, or after turn_end{completed|interrupted}
  | "thinking" // model producing output; turn active, no tool outstanding
  | "tool-executing" // a tool_call is open, awaiting its tool_result
  | "recovering" // a RETRIABLE runtime_error occurred; process alive, backoff/fallback
  | "crashed" // turn_end{crashed}, or a TERMINAL runtime_error
  | "opaque"; // wire-layer only: an event kind this consumer's version cannot interpret

/**
 * #840 seam — which `runtime_error` is recoverable (fold → `recovering`) versus
 * terminal (fold → `crashed`). **A retriable failure MUST NOT fold to terminal.**
 *
 * `capacity` (an account-level rate-limit / provider capacity / remote-compaction
 * failure) is the #840 target: transient, not agent-terminal. Exhaustive over
 * `DiagnosticClass` so a new class forces a retriable/terminal decision at build
 * time rather than defaulting silently.
 *
 * `unknown` is conservatively NON-retriable: we do not resurrect a process on a
 * failure we could not classify. Which raw errors map to `capacity` is pinned
 * when the real captured capacity signature lands (acceptance-gated, task #840).
 */
export function isRetriableError(detail: Diagnostic): boolean {
  switch (detail.errorClass) {
    case "capacity": // #840: rate-limit / capacity / compaction — transient
    case "stalled": // may clear on retry
      return true;
    case "launch_failed":
    case "credential_missing":
    case "crashed":
    case "protocol_violation":
    case "unknown":
      return false;
    default: {
      const unhandled: never = detail.errorClass;
      return unhandled;
    }
  }
}

/**
 * One fold step. `crashed` is absorbing — a terminal turn is not un-crashed by
 * later noise. `opaque` is likewise absorbing: once a consumer has seen an event
 * it could not interpret, it cannot honestly claim a precise status afterward.
 *
 * The `never` default is the in-process exhaustiveness tooth: adding a
 * `RuntimeEvent` variant fails the build here rather than folding to a wrong
 * status by omission.
 */
export function stepTurnStatus(prev: TurnStatus, event: RuntimeEvent): TurnStatus {
  if (prev === "crashed" || prev === "opaque") {
    return prev;
  }
  switch (event.kind) {
    case "text":
      return "thinking";
    case "tool_call":
      return "tool-executing";
    case "tool_result":
      return "thinking";
    case "turn_end":
      return event.reason === "crashed" ? "crashed" : "idle";
    case "runtime_error":
      return isRetriableError(event.detail) ? "recovering" : "crashed";
    default: {
      const unhandled: never = event;
      return unhandled;
    }
  }
}

/** In-process fold: events are typed `RuntimeEvent`s from the same build. */
export function foldTurnStatus(events: readonly RuntimeEvent[]): TurnStatus {
  let status: TurnStatus = "idle";
  for (const event of events) {
    status = stepTurnStatus(status, event);
  }
  return status;
}

/** The event kinds this build knows. A wire event outside this set is `opaque`. */
const KNOWN_EVENT_KINDS: ReadonlySet<string> = new Set<RuntimeEvent["kind"]>([
  "text",
  "tool_call",
  "tool_result",
  "turn_end",
  "runtime_error",
]);

/**
 * The cross-version fault line. A wire deserialiser (a follow-on: it must rebuild
 * a `runtime_error`'s `Diagnostic` via `Diagnostic.fromRaw`, since that
 * constructor is private) uses this to decide whether a wire event folds
 * normally or degrades to `opaque`.
 */
export function isKnownEventKind(kind: unknown): kind is RuntimeEvent["kind"] {
  return typeof kind === "string" && KNOWN_EVENT_KINDS.has(kind);
}
