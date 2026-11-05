import { conversationOf, initialConversation, reduceConversation } from "./conversation.js";
import { findCarriedInput } from "./input-carries.js";
import type { InputHandled } from "./turns.js";
import type { FailureClass, RawEvent, TurnOutcome } from "../contracts/session.js";

/** Bind a live attempt at the cursor; a settled attempt cannot own a later retry. */
export function inputRequestAt(records: readonly RawEvent[], afterSeq: number, sessionId?: string, inputId?: string): string | undefined {
  if (inputId === undefined) { return undefined; }
  const prefix = records.filter(record => record.seq <= afterSeq && record.agentPath.length === 0
    && (sessionId === undefined || record.sessionId === sessionId));
  const request = prefix.findLast(record => record.kind === "request" && record.direction === "toRuntime"
    && "input" in record.body && record.body.inputId === inputId);
  if (request?.kind !== "request") { return undefined; }
  if (request.seq === afterSeq) { return request.id; }
  const input = [...conversationOf(prefix).inputs.values()].find(entry => entry.attempts.some(attempt => attempt.request.id === request.id));
  return input?.disposition !== undefined || input?.state === "dropped" || input?.state === "withdrawn" || input?.state === "rejected"
    ? undefined : request.id;
}

/** Per-attempt admission and adapter delivery facts, shared by retained/live waits. */
export function inputWait(afterSeq: number, inputId?: string, boundRequest?: string): {
  waiting(): boolean;
  read(record: RawEvent): TurnOutcome | InputHandled | null;
} {
  let waitingForInput = false;
  let waitingForAdapter = false;
  const nativeAdmissions = new Set<string>();
  const attempts = new Set(boundRequest === undefined ? [] : [boundRequest]);
  const withdrawals = new Set<string>();
  const dispatches = new Set<string>();
  let superseded = false;
  let conversation = initialConversation();
  return {
    waiting: (): boolean => waitingForInput || nativeAdmissions.size > 0,
    read(record: RawEvent): TurnOutcome | InputHandled | null {
      if (inputId === undefined) { return null; }
      conversation = reduceConversation(conversation, record);
      if (record.kind === "request" && record.direction === "toRuntime") {
        const body = record.body;
        if (body.kind === "withdraw" && body.inputId === inputId && !superseded) { withdrawals.add(record.id); }
        if ("input" in body) {
          if (attempts.size === 0 && record.seq >= afterSeq && body.inputId === inputId) { attempts.add(record.id); }
          const carries = body.kind === "prompt" ? body.carries : undefined;
          if (!superseded && carries?.some(id => (id === inputId || attempts.has(id))
            && findCarriedInput(conversation.inputs, record, id)?.attempts.some(attempt => attempt.request.id === record.id) === true) === true) {
            attempts.add(record.id); dispatches.add(record.id);
          }
          if (record.seq > afterSeq && body.inputId === inputId && !attempts.has(record.id)) { superseded = true; }
          if (attempts.has(record.id) && body.kind === "prompt" && body.admission === "native") { nativeAdmissions.add(record.id); }
        }
      }
      if (record.kind === "response") {
        const { requestId, body } = record;
        const dispatched = dispatches.has(requestId) || nativeAdmissions.has(requestId);
        nativeAdmissions.delete(requestId);
        if (attempts.has(requestId) && body.kind === "accepted") {
          if (body.queued === "adapter") { waitingForAdapter = true; waitingForInput = true; }
          else if (waitingForAdapter) { waitingForAdapter = false; waitingForInput = false; }
        }
        if (withdrawals.has(requestId) && body.kind === "accepted") {
          waitingForInput = false; waitingForAdapter = false;
          if (record.seq > afterSeq) { return { kind: "aborted" }; }
        }
        if (dispatched && body.kind === "rejected") {
          waitingForInput = false; waitingForAdapter = false;
          if (record.seq > afterSeq) { return { kind: "failed", failure: "unknown", reason: body.reason }; }
        }
      }
      if (record.kind !== "frame") { return null; }
      for (const event of record.body.events) {
        if (event.kind === "turn_active" && record.body.responseTo !== undefined) { nativeAdmissions.delete(record.body.responseTo); }
        if (event.kind === "input_handled" && record.seq > afterSeq && attempts.has(event.requestId)) {
          return { kind: "handled", requestId: event.requestId, ...(event.inputId === undefined ? {} : { inputId: event.inputId }), seq: record.seq };
        }
        if (event.kind === "input_queued" && event.inputId === inputId) { waitingForInput = true; }
        if (event.kind === "turn_active" && event.inputId === inputId) { waitingForInput = false; }
        if (event.kind === "input_dropped" && (event.requestId === undefined ? event.inputId === inputId : attempts.has(event.requestId))) {
          waitingForInput = false;
          if (event.requestId !== undefined) { nativeAdmissions.delete(event.requestId); }
          if (record.seq > afterSeq) { return droppedOutcome(event); }
        }
      }
      return null;
    },
  };
}

export function droppedOutcome(event: { readonly reason: string; readonly failure?: FailureClass; readonly message?: string }): TurnOutcome {
  return event.reason === "turn_interrupted" ? { kind: "aborted" }
    : { kind: "failed", failure: event.failure ?? "unknown", reason: event.message ?? "runtime refused the input" };
}
