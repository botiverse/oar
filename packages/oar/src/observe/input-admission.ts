import type { StatusState } from "./status-state.js";
import type { AgentStatus, RawEvent, RuntimeEventBody } from "../contracts/session.js";

/** A provisional prompt reservation and the native activity observed beside it. */
export interface InputAdmission {
  readonly requestId: string;
  readonly inputId?: string;
  readonly idle: Extract<AgentStatus, { kind: "idle" }>;
  readonly seq: number;
  readonly native?: true;
  /** Underlying idle after an independent run ended during this admission. */
  readonly nativeIdle?: Extract<AgentStatus, { kind: "idle" }>;
  readonly nativeSinceSeq?: number;
}

/** Only native activity, never a control acceptance, establishes a running turn. */
function startsActivity(event: RuntimeEventBody): boolean {
  return event.kind === "turn_active" || event.kind === "text_delta" || event.kind === "reasoning"
    || event.kind === "tool_call_started" || event.kind === "tool_call_ended" || event.kind === "retry";
}

function observeAdmission(admission: InputAdmission | undefined, before: AgentStatus, record: RawEvent): InputAdmission | undefined {
  if (record.kind === "request" && record.direction === "toRuntime" && record.body.kind === "prompt"
    && before.kind === "idle" && before.pendingPrompt === undefined && before.released !== true) {
    return { requestId: record.id, ...(record.body.inputId === undefined ? {} : { inputId: record.body.inputId }), idle: before, seq: record.seq,
      ...(record.body.admission === "native" ? { native: true } : {}) };
  }
  if (admission !== undefined && record.kind === "frame" && record.body.events.some(startsActivity)) {
    return { ...admission, nativeSinceSeq: admission.nativeIdle === undefined ? (admission.nativeSinceSeq ?? record.seq) : record.seq };
  }
  return admission;
}

/** Handling/refusal releases this attempt, never an independently observed native turn. */
function releaseAdmission(status: AgentStatus, admission: InputAdmission | undefined, requestId: string, at: number): AgentStatus {
  if (admission?.requestId !== requestId || status.kind !== "running" || status.requestId !== requestId) { return status; }
  if (admission.nativeSinceSeq === undefined) { return admission.idle; }
  const { requestId: _requestId, inputId: _inputId, ...native } = status;
  return { ...native, sinceSeq: admission.nativeSinceSeq, lastEventAt: at };
}

/** Preserve the reservation checkpoint separately from the public phase. */
export function reduceInputAdmission(prior: InputAdmission | undefined, before: StatusState, reduced: StatusState, record: RawEvent): StatusState {
  let admission = observeAdmission(prior, before, record);
  let status = reduced;
  const disposed = record.kind === "response" && (record.body.kind === "exited" || record.body.kind === "released");
  const rejected = record.kind === "response" && record.body.kind === "rejected" && record.requestId === admission?.requestId;
  const disposition = record.kind === "frame" ? record.body.events.find(event =>
    (event.kind === "input_handled" || event.kind === "input_dropped") && event.requestId !== undefined && event.requestId === admission?.requestId) : undefined;
  if (admission !== undefined && (rejected || disposition !== undefined)) {
    // Native activity can precede this request's receipt. Release only its
    // reservation; do not infer handling for logs without that receipt.
    if (!rejected || admission.native === true) {
      status = releaseAdmission(rejected ? before : status, admission, admission.requestId, record.receivedAt);
    }
    admission = undefined;
  }
  const admitted = admission?.native === true && (
    (record.kind === "response" && record.requestId === admission.requestId && record.body.kind === "accepted")
    || (record.kind === "frame" && record.body.responseTo === admission.requestId && record.body.events.some(event => event.kind === "turn_active")));
  if (disposed || admitted || (status.kind === "idle" && admission?.native !== true)) { admission = undefined; }
  if (admission === undefined) { return status; }
  const { nativeIdle: _idle, ...pending } = admission;
  if (status.kind === "idle") {
    return { kind: "running", sinceSeq: admission.seq, requestId: admission.requestId,
      ...(admission.inputId === undefined ? {} : { inputId: admission.inputId }),
      phase: "waiting_model", lastEventAt: record.receivedAt, inputAdmission: { ...pending, nativeIdle: status } };
  }
  return { ...status, inputAdmission: pending };
}
