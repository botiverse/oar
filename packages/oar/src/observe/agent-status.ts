import type { EventView, SessionRecord, TurnOutcome } from "../contracts/session.js";

/**
 * status = fold(records). The reducer is pure — no clock, no IO — so status is
 * replayable from any record log and snapshot-testable. Time-qualified
 * judgments (stalled) are deliberately OUTSIDE the ontology: they are
 * fold(records) × clock, provided by `stallOf` next to it.
 *
 * Transition table (root agent only — child records advance nothing here):
 *   request prompt (toRuntime)        → running/waiting_model (the turn's start IS the request)
 *   response rejected → that request  → idle again (the turn never began)
 *   event reasoning                   → running/thinking
 *   event text_delta                  → running/responding
 *   event tool_call_started           → running/{tool, callId}
 *   event tool_call_ended             → running/waiting_model   (the model consumes the result next)
 *   event turn_ended                  → idle{lastTurnOutcome}   (the runtime's own completion)
 *   response exited                   → idle{failed runtime_exited} if a turn was running
 * The fold is total: a mid-turn event while idle adopts that turn (a consumer
 * may subscribe mid-turn, and a queued input runs as a turn with no request).
 */

export type RunningPhase =
  | "waiting_model"
  | "thinking"
  | "responding"
  | { readonly tool: string; readonly callId: string };

export type AgentStatus =
  | { readonly kind: "idle"; readonly lastTurnOutcome?: TurnOutcome }
  | {
      readonly kind: "running";
      /** seq of the record that opened this running span: the prompt request, or the first event of an adopted turn. */
      readonly sinceSeq: number;
      /** The prompt request id when the turn was opened through this Session; absent for adopted turns. */
      readonly requestId?: string;
      readonly phase: RunningPhase;
      /** Envelope receivedAt (unix epoch ms) of the latest folded record. */
      readonly lastEventAt: number;
    };

export const initialStatus: AgentStatus = { kind: "idle" };

function running(previous: AgentStatus, record: SessionRecord, phase: RunningPhase): AgentStatus {
  const sinceSeq = previous.kind === "running" ? previous.sinceSeq : record.seq;
  const requestId = previous.kind === "running" ? previous.requestId : undefined;
  return {
    kind: "running",
    sinceSeq,
    ...(requestId === undefined ? {} : { requestId }),
    phase,
    lastEventAt: record.receivedAt,
  };
}

export function reduceStatus(previous: AgentStatus, record: SessionRecord): AgentStatus {
  if (record.agentPath.length > 0) {
    return previous;
  }
  switch (record.kind) {
    case "request":
      return record.direction === "toRuntime" && record.body.kind === "prompt" && previous.kind === "idle"
        ? { kind: "running", sinceSeq: record.seq, requestId: record.id, phase: "waiting_model", lastEventAt: record.receivedAt }
        : previous;
    case "response":
      if (record.body.kind === "rejected" && previous.kind === "running" && previous.requestId === record.requestId) {
        return { kind: "idle" };
      }
      if (record.body.kind === "exited" && previous.kind === "running") {
        return { kind: "idle", lastTurnOutcome: { kind: "failed", reason: "runtime exited", failure: "runtime_exited" } };
      }
      return previous;
    case "event": {
      let status = previous;
      for (const view of record.body.views) {
        status = reduceView(status, record, view);
      }
      return status;
    }
    default:
      return previous;
  }
}

function reduceView(previous: AgentStatus, record: SessionRecord, view: EventView): AgentStatus {
  switch (view.kind) {
    case "reasoning":
      return running(previous, record, "thinking");
    case "text_delta":
      return running(previous, record, "responding");
    case "tool_call_started":
      return running(previous, record, { tool: view.tool, callId: view.callId });
    case "tool_call_ended":
      return running(previous, record, "waiting_model");
    case "turn_ended":
      return { kind: "idle", lastTurnOutcome: view.outcome };
    case "usage":
    case "model":
      return previous;
  }
  return previous;
}

/** fold(records) × clock: how long a running status has been silent, if beyond the threshold. */
export function stallOf(
  status: AgentStatus,
  nowMs: number,
  thresholdMs: number,
): { readonly sinceSeq: number; readonly silentForMs: number } | null {
  if (status.kind !== "running") {
    return null;
  }
  const silentForMs = nowMs - status.lastEventAt;
  return silentForMs >= thresholdMs ? { sinceSeq: status.sinceSeq, silentForMs } : null;
}
