import type { SessionEvent, TurnOutcome } from "../contracts/session.js";

/**
 * status = fold(events). The reducer is pure — no clock, no IO — so status is
 * replayable from any event log and snapshot-testable. Time-qualified
 * judgments (stalled) are deliberately OUTSIDE the ontology: they are
 * fold(events) × clock, provided by `stallOf` next to it.
 *
 * Transition table (from the minimal v1 event union):
 *   turn_started      → running/waiting_model
 *   thinking_delta    → running/thinking
 *   text_delta        → running/responding
 *   tool_call_started → running/{tool, callId}
 *   tool_call_ended   → running/waiting_model   (the model consumes the result next)
 *   turn_ended        → idle{lastTurnOutcome}
 * The fold is total: any mid-turn event while idle adopts that turn (a
 * consumer may subscribe mid-turn, and claude can start a turn on its own).
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
      readonly turnId: string;
      readonly phase: RunningPhase;
      /** Envelope receivedAt (unix epoch ms) of the latest folded event. */
      readonly lastEventAt: number;
    };

export const initialStatus: AgentStatus = { kind: "idle" };

function running(event: SessionEvent, phase: RunningPhase): AgentStatus {
  return { kind: "running", turnId: event.turnId, phase, lastEventAt: event.receivedAt };
}

export function reduceStatus(previous: AgentStatus, event: SessionEvent): AgentStatus {
  switch (event.kind) {
    case "turn_started":
      return running(event, "waiting_model");
    case "thinking_delta":
      return running(event, "thinking");
    case "text_delta":
      return running(event, "responding");
    case "tool_call_started":
      return running(event, { tool: event.tool, callId: event.callId });
    case "tool_call_ended":
      return running(event, "waiting_model");
    case "turn_ended":
      return { kind: "idle", lastTurnOutcome: event.outcome };
    default:
      return previous;
  }
}

/** fold(events) × clock: how long a running status has been silent, if beyond the threshold. */
export function stallOf(
  status: AgentStatus,
  nowMs: number,
  thresholdMs: number,
): { readonly turnId: string; readonly silentForMs: number } | null {
  if (status.kind !== "running") {
    return null;
  }
  const silentForMs = nowMs - status.lastEventAt;
  return silentForMs >= thresholdMs ? { turnId: status.turnId, silentForMs } : null;
}
