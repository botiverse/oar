import type { AgentStatus, RawEvent, TurnOutcome } from "../contracts/session.js";

type TurnStop = NonNullable<Extract<AgentStatus, { kind: "running" }>["stop"]>;

/** Fold only the current root turn's controls; callers own scope and turn boundaries. */
export function reduceTurnStop(previous: TurnStop | undefined, record: RawEvent): TurnStop | undefined {
  const pending = previous?.pendingAbortIds ?? [];
  const aborted = previous?.abortedOnExit === true;
  if (record.kind === "request" && record.direction === "toRuntime") {
    if (record.body.kind === "dispose") {
      return { pendingAbortIds: pending, abortedOnExit: true };
    }
    if (record.body.kind === "abort") {
      return { pendingAbortIds: [...pending, record.id], abortedOnExit: aborted };
    }
  }
  if (record.kind === "response" && (record.body.kind === "accepted" || record.body.kind === "rejected") && pending.includes(record.requestId)) {
    const remaining = pending.filter((id) => id !== record.requestId);
    const abortedOnExit = aborted || record.body.kind === "accepted";
    return remaining.length === 0 && !abortedOnExit ? undefined : { pendingAbortIds: remaining, abortedOnExit };
  }
  return previous;
}

/** An observed exit ends stopped work as aborted, preserving the exit record itself. */
export function exitTurnOutcome(stop: TurnStop | undefined): TurnOutcome {
  return stop?.abortedOnExit === true
    ? { kind: "aborted" }
    : { kind: "failed", reason: "runtime exited", failure: "runtime_exited" };
}
