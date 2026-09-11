import type { EventView, SessionRecord, TurnOutcome } from "../contracts/session.js";

/**
 * status = fold(records). The reducer is pure (no clock, no IO), so status
 * is replayable from any record log and snapshot-testable. Time-qualified
 * judgments (stalled) are deliberately OUTSIDE the ontology: they are
 * fold(records) × clock, provided by `stallOf` next to it.
 *
 * Scope: the ROOT AGENT of ONE SESSION. Pass the session id so a derived
 * child session's records (codex child threads, grok child sessions carry
 * their own sessionId with agentPath []) never drive the root's phase; without
 * it, every root-agent record of any session is folded (single-session
 * streams). Phase transitions come from the root agent's own records only;
 * `lastEventAt`, the liveness clock, refreshes on EVERY record attributable
 * to the session (child agents, child sessions, viewless frames), because a
 * delegated sub-agent working is not a stalled root.
 *
 * Transition table:
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

export function reduceStatus(previous: AgentStatus, record: SessionRecord, sessionId?: string): AgentStatus {
  const foreignSession = sessionId !== undefined && record.sessionId !== sessionId;
  if (foreignSession && !belongsToSession(record, sessionId)) {
    return previous;
  }
  if (foreignSession || record.agentPath.length > 0 || (record.kind === "event" && record.body.views.length === 0)) {
    // A child agent, a child session, or a frame without a view: the session is
    // alive, so the clock moves, but the root agent's phase does not.
    return previous.kind === "running" ? { ...previous, lastEventAt: record.receivedAt } : previous;
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

/**
 * Whether a record of another session id belongs to this session's activity.
 * The stream only ever carries the session's own records and its derived
 * children's (docs/spec/session-graph-and-cursor.md), so every record in it
 * counts; the hook exists so a consumer folding a merged multi-session log can
 * narrow it.
 */
function belongsToSession(_record: SessionRecord, _sessionId: string): boolean {
  return true;
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
