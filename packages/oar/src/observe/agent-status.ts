import type { AgentStatus, QueryResult, RawEvent, RunningPhase, RuntimeEventBody } from "../contracts/session.js";

import { exitTurnOutcome, reduceTurnStop } from "./turn-stop.js";

export type { AgentStatus, RunningPhase } from "../contracts/session.js";

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
 * to the session (child agents, child sessions, frames oar read nothing from), because a
 * delegated sub-agent working is not a stalled root.
 *
 * Transition table:
 *   request prompt (toRuntime)        → running/waiting_model (provisional request-based start)
 *   response rejected → that request  → idle again (the turn never began)
 *   event input_queued                → arm pending input; visible status is unchanged
 *   event turn_active                 → running at its native start; pending inputId must match
 *   event reasoning                   → running/thinking
 *   event text_delta                  → running/responding
 *   event tool_call_started           → running/{tool, callId}
 *   event tool_call_ended             → running/waiting_model   (the model consumes the result next)
 *   event tool_call_progress          → running, phase unchanged (the clock moves)
 *   event tool_call_input             → running, phase unchanged (the clock moves)
 *   event tool_call_input_delta       → running, phase unchanged (the clock moves)
 *   event compaction_started          → running/compacting
 *   event compaction_ended           → running/waiting_model only if already running; idle stays idle
 *   event retry                      → running/waiting_model
 *   event turn_ended                  → idle{lastTurnOutcome}   (the runtime's own completion)
 *   accepted abort / request dispose  → retain stop evidence for this turn
 *   response exited                   → idle{aborted} after accepted abort / dispose
 *                                     → idle{failed runtime_exited} otherwise
 * The fold is total: a mid-turn event while idle adopts that turn (a consumer
 * may subscribe mid-turn, and a queued input runs as a turn with no request).
 */

export const initialStatus: AgentStatus = { kind: "idle" };

/** The status fold over a retained log, as a query (`Session.status()`): `seq` is the last record consumed, -1 before any. */
export function statusOf(records: readonly RawEvent[], sessionId?: string): QueryResult<AgentStatus> {
  let value = initialStatus;
  let seq = -1;
  for (const record of records) {
    value = reduceStatus(value, record, sessionId);
    seq = record.seq;
  }
  return { value, seq };
}

function running(previous: AgentStatus, record: RawEvent, phase: RunningPhase): AgentStatus {
  const sinceSeq = previous.kind === "running" ? previous.sinceSeq : record.seq;
  const requestId = previous.kind === "running" ? previous.requestId : undefined;
  return {
    kind: "running",
    sinceSeq,
    ...(requestId === undefined ? {} : { requestId }),
    ...(previous.kind === "running" && previous.stop !== undefined ? { stop: previous.stop } : {}),
    ...(previous.kind === "running" && previous.inputId !== undefined ? { inputId: previous.inputId } : {}),
    ...(previous.pendingPrompt === undefined ? {} : { pendingPrompt: previous.pendingPrompt }),
    phase,
    lastEventAt: record.receivedAt,
  };
}

export function reduceStatus(previous: AgentStatus, record: RawEvent, sessionId?: string): AgentStatus {
  const foreignSession = sessionId !== undefined && record.sessionId !== sessionId;
  if (foreignSession && !belongsToSession(record, sessionId)) {
    return previous;
  }
  if (foreignSession || record.agentPath.length > 0 || (record.kind === "frame" && record.body.events.length === 0)) {
    // A child agent, a child session, or a frame oar read nothing from: the session is
    // alive, so the clock moves, but the root agent's phase does not.
    return previous.kind === "running" ? { ...previous, lastEventAt: record.receivedAt } : previous;
  }
  if (previous.pendingPrompt !== undefined && (previous.kind === "idle" || previous.inputId === previous.pendingPrompt.inputId
    || (record.kind === "request" && record.body.kind === "dispose")
    || (record.kind === "response" && previous.pendingPrompt.stop?.pendingAbortIds.includes(record.requestId) === true))) {
    const { stop: priorStop, ...pendingPrompt } = previous.pendingPrompt;
    const stop = reduceTurnStop(priorStop, record);
    if (stop !== priorStop) { previous = { ...previous, pendingPrompt: stop === undefined ? pendingPrompt : { ...pendingPrompt, stop } }; }
  }
  if (previous.kind === "running") {
    const { stop: priorStop, ...active } = previous;
    const stop = reduceTurnStop(priorStop, record);
    if (stop !== priorStop) { previous = stop === undefined ? active : { ...active, stop }; }
  }
  switch (record.kind) {
    case "request":
      return record.direction === "toRuntime" && record.body.kind === "prompt" && previous.kind === "idle" && previous.pendingPrompt === undefined
        ? { kind: "running", sinceSeq: record.seq, requestId: record.id, ...(record.body.inputId === undefined ? {} : { inputId: record.body.inputId }), phase: "waiting_model", lastEventAt: record.receivedAt }
        : previous;
    case "response":
      if (record.body.kind === "rejected" && previous.kind === "running" && previous.requestId === record.requestId) {
        return { kind: "idle" };
      }
      if (record.body.kind === "exited" && previous.kind === "idle") { return { kind: "idle", ...(previous.lastTurnOutcome === undefined ? {} : { lastTurnOutcome: previous.lastTurnOutcome }) }; }
      if (record.body.kind === "exited" && previous.kind === "running") {
        return { kind: "idle", lastTurnOutcome: exitTurnOutcome(previous.stop) };
      }
      return previous;
    case "frame": {
      let status = previous;
      for (const event of record.body.events) {
        status = reduceEvent(status, record, event);
      }
      return status;
    }
    default:
      return previous;
  }
}

function reduceEvent(previous: AgentStatus, record: RawEvent, event: RuntimeEventBody): AgentStatus {
  switch (event.kind) {
    case "input_queued": {
      const own = previous.kind === "running" && previous.inputId === event.inputId;
      const pendingPrompt = { inputId: event.inputId, sinceSeq: own ? previous.sinceSeq : record.seq,
        ...(own && previous.requestId !== undefined ? { requestId: previous.requestId } : {}),
        ...(own && previous.stop !== undefined ? { stop: previous.stop } : {}) };
      return { ...previous, pendingPrompt, ...(previous.kind === "running" ? { lastEventAt: record.receivedAt } : {}) };
    }
    case "turn_active":
      if (event.inputId !== undefined && previous.pendingPrompt?.inputId === event.inputId) {
        return waitingForPrompt(previous.pendingPrompt, record, false);
      }
      if (previous.pendingPrompt !== undefined && (previous.kind === "idle" || previous.inputId === previous.pendingPrompt.inputId)) {
        return { kind: "running", sinceSeq: record.seq, phase: "waiting_model", lastEventAt: record.receivedAt, pendingPrompt: previous.pendingPrompt };
      }
      return previous.kind === "running" ? { ...previous, lastEventAt: record.receivedAt } : running(previous, record, "waiting_model");
    case "reasoning":
      return running(previous, record, "thinking");
    case "text_delta":
      return running(previous, record, "responding");
    case "tool_call_started":
      return running(previous, record, { tool: event.tool, callId: event.callId });
    case "tool_call_ended":
    case "retry":
      return running(previous, record, "waiting_model");
    case "compaction_ended":
      return previous.kind === "running" ? running(previous, record, "waiting_model") : previous;
    case "compaction_started":
      return running(previous, record, "compacting");
    case "tool_call_progress":
    case "tool_call_input":
    case "tool_call_input_delta":
      return previous.kind === "running" ? { ...previous, lastEventAt: record.receivedAt } : previous;
    case "turn_ended":
      return previous.pendingPrompt === undefined
        ? { kind: "idle", lastTurnOutcome: event.outcome }
        : waitingForPrompt(previous.pendingPrompt, record, true);
    case "task_started":
    case "task_updated":
    case "task_ended":
      // Tasks run beside the turn; whether the agent is busy is the turn's fact, but a report is activity.
      return previous.kind === "running" ? { ...previous, lastEventAt: record.receivedAt } : previous;
    case "input_dropped": {
      if (previous.kind === "running" && previous.inputId === event.inputId) { return { kind: "idle" }; }
      if (previous.pendingPrompt?.inputId !== event.inputId) { return previous; }
      const { pendingPrompt: _pending, ...status } = previous;
      return status;
    }
    case "app_request_cancelled":
    case "user_message":
    case "usage":
    case "model":
    case "effort":
    case "service_tier":
      return previous;
  }
  return previous;
}

/** A notification can finish while the accepted host input still owns the slot. */
function waitingForPrompt(pending: NonNullable<AgentStatus["pendingPrompt"]>, record: RawEvent, keepPending: boolean): AgentStatus {
  return { kind: "running", sinceSeq: pending.sinceSeq, inputId: pending.inputId,
    ...(pending.requestId === undefined ? {} : { requestId: pending.requestId }),
    ...(pending.stop === undefined ? {} : { stop: pending.stop }),
    ...(keepPending ? { pendingPrompt: pending } : {}), phase: "waiting_model", lastEventAt: record.receivedAt };
}

/**
 * Whether a record of another session id belongs to this session's activity.
 * The stream only ever carries the session's own records and its derived
 * children's (docs/spec/session-graph-and-cursor.md), so every record in it
 * counts; the hook exists so a consumer folding a merged multi-session log can
 * narrow it.
 */
function belongsToSession(_record: RawEvent, _sessionId: string): boolean {
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
