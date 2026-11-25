import { dispatchStatus, isHeldOvertake, reduceAdapterQueue } from "./adapter-queue.js";
import { reduceInputAdmission } from "./input-admission.js";
import type { AgentStatus, QueryResult, RawEvent, RunningPhase, RuntimeEventBody } from "../contracts/session.js";
import { exitTurnOutcome, releaseTurnOutcome, reduceTurnStop } from "./turn-stop.js";
import { initialStatus, statusValue, type StatusState } from "./status-state.js";

export { initialStatus, statusValue, type StatusState } from "./status-state.js";
export type { AgentStatus, RunningPhase } from "../contracts/session.js";
/**
 * Replayable status = fold(records); `stallOf` adds time-qualified stall judgments.
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
 * Transition table (content rows change phase only while running; while
 * idle they update the optional activity timestamps):
 *   request prompt (toRuntime)        → running/waiting_model (provisional request-based start)
 *   response rejected → that request  → idle again (the turn never began)
 *   event input_queued                → arm pending input; visible status is unchanged
 *   event turn_active                 → running at its native start; pending inputId must match
 *   reasoning / text / tool start     → thinking / responding / tool phase
 *   tool end / retry / compaction end → waiting_model; idle records activity
 *   tool progress / input             → update the current tool phase and clock
 *   compaction start                  → compacting only inside an existing turn
 *   event turn_ended                  → idle{lastTurnOutcome}   (the runtime's own completion)
 *   accepted abort / request dispose  → retain stop evidence for this turn
 *   response exited                   → idle{aborted} after accepted abort / dispose
 *                                     → idle{failed runtime_exited} otherwise
 *   response released                 → idle/released, retaining the stop-based outcome
 *   later facts after release         → retain idle/released; native facts remain in the log
 * Only a prompt, admitted manual compaction or native turn start adopts a turn. Content while idle records
 * outside-turn activity; a sliced stream needs its preceding start or checkpoint.
 */

function compactionIdle(previous: StatusState): StatusState {
  const lastTurnOutcome = previous.compactionState?.lastTurnOutcome;
  return { kind: "idle", ...(lastTurnOutcome === undefined ? {} : { lastTurnOutcome }) };
}

/** The status fold over a retained log, as a query (`Session.status()`): `seq` is the last record consumed, -1 before any. */
export function statusOf(records: readonly RawEvent[], sessionId?: string): QueryResult<AgentStatus> {
  let value = initialStatus;
  let seq = -1;
  for (const record of records) {
    value = reduceStatus(value, record, sessionId);
    seq = record.seq;
  }
  return { value: statusValue(value), seq };
}

function running(previous: StatusState, record: RawEvent, phase: RunningPhase): StatusState {
  const sinceSeq = previous.kind === "running" ? previous.sinceSeq : record.seq;
  const requestId = previous.kind === "running" ? previous.requestId : undefined;
  return {
    kind: "running",
    sinceSeq,
    ...(requestId === undefined ? {} : { requestId }),
    ...(previous.kind === "running" && previous.stop !== undefined ? { stop: previous.stop } : {}),
    ...(previous.kind === "running" && previous.inputId !== undefined ? { inputId: previous.inputId } : {}),
    ...(previous.compactionState === undefined ? {} : { compactionState: previous.compactionState }),
    ...(previous.pendingPrompt === undefined ? {} : { pendingPrompt: previous.pendingPrompt }),
    ...(previous.kind === "running" && previous.compaction !== undefined ? { compaction: previous.compaction } : {}),
    phase: previous.kind === "running" && previous.compaction !== undefined ? "compacting" : phase,
    lastEventAt: record.receivedAt,
  };
}

/** Content proves activity, not an open turn. */
function content(previous: StatusState, record: RawEvent, phase: RunningPhase): StatusState {
  return previous.kind === "running" ? running(previous, record, phase) : activity(previous, record);
}

function activity(previous: StatusState, record: RawEvent): StatusState {
  return previous.kind === "idle"
    ? { ...previous, activity: { since: previous.activity?.since ?? record.receivedAt, lastEventAt: record.receivedAt } }
    : previous;
}

/** Fold one record using the complete previous checkpoint; preserve every returned field. */
export function reduceStatus(previous: StatusState, record: RawEvent, sessionId?: string): StatusState {
  const { adapterQueue, inputAdmission, ...core } = previous;
  const root = (sessionId === undefined || record.sessionId === sessionId) && record.agentPath.length === 0;
  const queue = root ? reduceAdapterQueue(adapterQueue, record) : adapterQueue;
  const before = adapterQueue?.idle ?? inputAdmission?.nativeIdle ?? core;
  const coreStatus = root && isHeldOvertake(adapterQueue, record) ? before : reduceCore(before, record, sessionId);
  const reduced = root ? dispatchStatus(adapterQueue, coreStatus, record) : coreStatus;
  const status: StatusState = root ? reduceInputAdmission(inputAdmission, before, reduced, record)
    : (inputAdmission === undefined ? reduced : { ...reduced, inputAdmission });
  const admission = status.inputAdmission;
  const waiting = queue?.inputs.find(input => input.accepted === true);
  if (status.kind === "idle" && status.released !== true && waiting !== undefined) {
    return { kind: "running", phase: "waiting_model", sinceSeq: waiting.seq, lastEventAt: record.receivedAt,
      ...(admission === undefined ? {} : { inputAdmission: admission }), adapterQueue: { ...queue, inputs: queue?.inputs ?? [], withdrawals: queue?.withdrawals ?? [], dispatches: queue?.dispatches ?? [], idle: status } };
  }
  return queue === undefined ? status : { ...status, adapterQueue: queue };
}

function reduceCore(previous: StatusState, record: RawEvent, sessionId?: string): StatusState {
  if (previous.kind === "idle" && previous.released === true) { return previous; }
  const foreignSession = sessionId !== undefined && record.sessionId !== sessionId;
  if (foreignSession && !belongsToSession(record, sessionId)) {
    return previous;
  }
  if (!foreignSession && record.agentPath.length === 0 && record.kind === "frame"
    && previous.kind === "running" && previous.compactionState?.settledBy === "native_response"
    && record.body.responseTo === previous.compaction?.requestId) { return compactionIdle(previous); }
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
      if (record.direction === "toRuntime" && record.body.kind === "compact" && previous.kind === "idle" && previous.pendingPrompt === undefined) {
        return { kind: "running", sinceSeq: record.seq, requestId: record.id, compaction: { requestId: record.id }, compactionState: { ...(record.body.settledBy === undefined ? {} : { settledBy: record.body.settledBy }), ...(previous.lastTurnOutcome === undefined ? {} : { lastTurnOutcome: previous.lastTurnOutcome }) }, phase: "compacting", lastEventAt: record.receivedAt };
      }
      if (record.direction === "toRuntime" && record.body.kind === "prompt" && previous.kind === "idle" && previous.pendingPrompt === undefined) {
        const inputId = record.body.inputId ?? (record.body.carries?.length === 1 ? record.body.carries[0] : undefined);
        return { kind: "running", sinceSeq: record.seq, requestId: record.id, ...(inputId === undefined ? {} : { inputId }), phase: "waiting_model", lastEventAt: record.receivedAt };
      }
      return previous;
    case "response":
      if (record.body.kind === "accepted" && record.spanId !== undefined && previous.kind === "running" && previous.compaction?.requestId === record.requestId) {
        return { ...previous, compactionState: { ...previous.compactionState, nativeTurn: true, spanId: record.spanId } };
      }
      if (record.body.kind === "released") {
        if (previous.kind === "running") { return { kind: "idle", released: true, lastTurnOutcome: releaseTurnOutcome(previous.stop) }; }
        if (previous.pendingPrompt !== undefined) { return { kind: "idle", released: true, lastTurnOutcome: releaseTurnOutcome(previous.pendingPrompt.stop) }; }
        return { ...previous, released: true };
      }
      if (record.body.kind === "rejected" && previous.kind === "running" && previous.requestId === record.requestId) {
        return compactionIdle(previous);
      }
      if (record.body.kind === "exited" && previous.kind === "idle") { return { kind: "idle", ...(previous.lastTurnOutcome === undefined ? {} : { lastTurnOutcome: previous.lastTurnOutcome }) }; }
      if (record.body.kind === "exited" && previous.kind === "running") {
        return { kind: "idle", lastTurnOutcome: exitTurnOutcome(previous.stop, record.body.reason) };
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

function reduceEvent(previous: StatusState, record: RawEvent, event: RuntimeEventBody): StatusState {
  switch (event.kind) {
    case "input_queued": {
      if (previous.kind === "running" && previous.compaction?.requestId === event.inputId) { return { ...previous, lastEventAt: record.receivedAt }; }
      const own = previous.kind === "running" && previous.inputId === event.inputId;
      const pendingPrompt = { inputId: event.inputId, sinceSeq: own ? previous.sinceSeq : record.seq,
        ...(own && previous.requestId !== undefined ? { requestId: previous.requestId } : {}),
        ...(own && previous.stop !== undefined ? { stop: previous.stop } : {}) };
      return { ...previous, pendingPrompt, ...(previous.kind === "running" ? { lastEventAt: record.receivedAt } : {}) };
    }
    case "turn_active":
      if (previous.kind === "running" && previous.compaction !== undefined) {
        if (event.inputId !== undefined && event.inputId !== previous.compaction.requestId) { return previous; }
        // Claude names the input at turn start. Codex identifies the turn
        // only at its compaction item, so an unrelated goal turn cannot own it.
        return event.inputId === undefined ? previous : { ...previous, compactionState: { ...previous.compactionState, nativeTurn: true }, lastEventAt: record.receivedAt };
      }
      if (event.inputId !== undefined && previous.pendingPrompt?.inputId === event.inputId) {
        return waitingForPrompt(previous.pendingPrompt, record, false);
      }
      if (previous.pendingPrompt !== undefined && (previous.kind === "idle" || previous.inputId === previous.pendingPrompt.inputId)) {
        return { kind: "running", sinceSeq: record.seq, phase: "waiting_model", lastEventAt: record.receivedAt, pendingPrompt: previous.pendingPrompt };
      }
      return previous.kind === "running" ? { ...previous, lastEventAt: record.receivedAt } : running(previous, record, "waiting_model");
    case "reasoning":
      return content(previous, record, "thinking");
    case "text_delta":
      return content(previous, record, "responding");
    case "tool_call_started":
      return content(previous, record, { tool: event.tool, callId: event.callId });
    case "tool_call_ended": // can arrive after its turn ended (codex background terminals): no turn to adopt
      return content(previous, record, "waiting_model");
    case "retry":
      return content(previous, record, "waiting_model");
    case "compaction_ended":
      if (previous.compactionState?.settledBy === "native_response") { return previous; }
      if (previous.kind === "running" && previous.compaction !== undefined && event.trigger !== undefined && event.trigger !== "manual") { return previous; }
      if (previous.kind === "running" && previous.compaction !== undefined && previous.compactionState?.compactionId !== undefined && event.compactionId !== previous.compactionState.compactionId) { return previous; }
      if (event.requestId !== undefined && previous.kind === "running" && previous.compaction !== undefined) {
        return event.requestId === previous.compaction.requestId ? compactionIdle(previous) : previous;
      }
      if (previous.kind === "running" && previous.compaction !== undefined && previous.compactionState?.nativeTurn !== true) { return previous.compaction.started === true ? compactionIdle(previous) : previous; }
      return content(previous, record, "waiting_model");
    case "compaction_started":
      if (previous.kind === "running" && previous.compaction !== undefined && previous.compactionState?.compactionId !== undefined && event.compactionId !== previous.compactionState.compactionId) { return previous; }
      if (previous.kind === "running" && previous.compaction !== undefined && previous.compactionState?.spanId !== undefined && record.spanId !== previous.compactionState.spanId) { return previous; }
      if (previous.kind === "running" && previous.compaction !== undefined && (event.trigger === "manual" || (event.trigger === undefined && (previous.compactionState?.nativeTurn === true || record.spanId !== undefined)))) {
        return { ...previous, compaction: { ...previous.compaction, started: true },
          compactionState: { ...previous.compactionState,
            ...(event.compactionId === undefined ? {} : { compactionId: previous.compactionState?.compactionId ?? event.compactionId }),
            ...(record.spanId === undefined ? {} : { nativeTurn: true, spanId: record.spanId }) }, lastEventAt: record.receivedAt };
      }
      return content(previous, record, "compacting");
    case "tool_call_input_delta":
    case "tool_call_input": {
      if (previous.kind !== "running") { return activity(previous, record); }
      const { phase } = previous;
      // Only the current call's phase changes: writing while its arguments stream, running once they are complete.
      if (typeof phase === "object" && phase.callId === event.callId) {
        return { ...previous, phase: event.kind === "tool_call_input_delta" ? { tool: phase.tool, callId: phase.callId, writing: true } : { tool: phase.tool, callId: phase.callId }, lastEventAt: record.receivedAt };
      }
      return { ...previous, lastEventAt: record.receivedAt };
    }
    case "tool_call_progress":
      return previous.kind === "running" ? { ...previous, lastEventAt: record.receivedAt } : activity(previous, record);
    case "turn_ended":
      if (previous.compactionState?.settledBy === "native_response") { return previous; }
      if (previous.kind === "running" && previous.compaction !== undefined
        && ((event.inputId !== undefined && event.inputId !== previous.compaction.requestId)
          || (previous.compactionState?.spanId !== undefined && record.spanId !== previous.compactionState.spanId))) { return previous; }
      if (previous.kind === "running" && previous.compaction !== undefined && previous.compactionState?.nativeTurn !== true) { return previous; }
      return previous.pendingPrompt === undefined
        ? { kind: "idle", lastTurnOutcome: event.outcome, ...(previous.kind === "idle" && previous.activity !== undefined ? { activity: previous.activity } : {}) }
        : waitingForPrompt(previous.pendingPrompt, record, true);
    case "task_started":
    case "task_updated":
    case "task_ended":
      // Tasks run beside the turn; whether the agent is busy is the turn's fact, but a report is activity.
      return previous.kind === "running" ? { ...previous, lastEventAt: record.receivedAt } : previous;
    case "input_dropped": {
      if (event.requestId !== undefined) { return previous; }
      if (previous.kind === "running" && previous.compaction?.requestId === event.inputId) { return compactionIdle(previous); }
      if (previous.kind === "running" && previous.inputId === event.inputId) { return { kind: "idle" }; }
      if (previous.pendingPrompt?.inputId !== event.inputId) { return previous; }
      const { pendingPrompt: _pending, ...status } = previous;
      return status;
    }
    case "app_request_cancelled":
    case "session_linked":
    case "user_message":
    case "input_handled":
    case "mcp_server_startup": case "goal_changed": case "plan_changed":
    case "usage":
    case "model":
    case "effort":
    case "service_tier":
      return previous;
  }
  return previous;
}

/** A notification can finish while the accepted host input still owns the slot. */
function waitingForPrompt(pending: NonNullable<AgentStatus["pendingPrompt"]>, record: RawEvent, keepPending: boolean): StatusState {
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
