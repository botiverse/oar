import type { StatusState } from "./status-state.js";
import type { AgentStatus, RawEvent } from "../contracts/session.js";

interface QueuedInput { readonly requestId: string; readonly inputId: string; readonly seq: number; readonly accepted?: true }
/** Serializable control facts, not claims that the runtime started or consumed an input. */
export interface AdapterQueueState {
  readonly inputs: readonly QueuedInput[];
  readonly withdrawals: readonly { readonly requestId: string; readonly inputId: string }[];
  readonly dispatches: readonly { readonly requestId: string; readonly inputIds: readonly string[]; readonly seq?: number; readonly ended?: true }[];
  /** Underlying idle state while the displayed phase is waiting for adapter dispatch. */
  readonly idle?: Extract<AgentStatus, { kind: "idle" }>;
}

export function reduceAdapterQueue(previous: AdapterQueueState | undefined, record: RawEvent): AdapterQueueState | undefined {
  let inputs = previous?.inputs ?? [];
  let withdrawals = previous?.withdrawals ?? [];
  let dispatches = previous?.dispatches ?? [];
  if (record.kind === "request" && record.direction === "toRuntime") {
    const body = record.body;
    if (body.kind === "queue") { inputs = [...inputs, { requestId: record.id, inputId: body.inputId ?? record.id, seq: record.seq }]; }
    if (body.kind === "withdraw") { withdrawals = [...withdrawals, { requestId: record.id, inputId: body.inputId }]; }
    if (body.kind === "prompt" && body.carries !== undefined && inputs.some(input => body.carries?.includes(input.inputId) === true)) {
      dispatches = [...dispatches, { requestId: record.id, inputIds: body.carries, seq: record.seq }];
    }
    if (body.kind === "dispose") { return undefined; }
  }
  if (record.kind === "response") {
    if (record.body.kind === "exited" || record.body.kind === "released") { return undefined; }
    const dispatch = dispatches.find(entry => entry.requestId === record.requestId);
    if (dispatch !== undefined && record.body.kind === "accepted") { inputs = inputs.filter(input => !dispatch.inputIds.includes(input.inputId)); }
    dispatches = dispatches.filter(entry => entry.requestId !== record.requestId);
    const withdrawing = withdrawals.find(entry => entry.requestId === record.requestId);
    if (withdrawing !== undefined && record.body.kind === "accepted") { inputs = inputs.filter(input => input.inputId !== withdrawing.inputId); }
    withdrawals = withdrawals.filter(entry => entry.requestId !== record.requestId);
    const accepted = record.body.kind === "accepted" && record.body.queued === "adapter";
    inputs = inputs.flatMap(input => input.requestId !== record.requestId ? [input] : (accepted ? [{ ...input, accepted: true as const }] : []));
  }
  if (record.kind === "frame") {
    for (const event of record.body.events) {
      if (event.kind === "turn_ended") {
        dispatches = dispatches.map(entry => event.inputId === undefined || entry.inputIds.includes(event.inputId) ? { ...entry, ended: true as const } : entry);
      }
      if (event.kind !== "input_handled" && event.kind !== "input_dropped") { continue; }
      const dispatch = dispatches.find(entry => entry.requestId === event.requestId);
      inputs = inputs.filter(input => event.requestId === undefined ? input.inputId !== event.inputId
        : input.requestId !== event.requestId && dispatch?.inputIds.includes(input.inputId) !== true);
      dispatches = dispatches.filter(entry => event.requestId === undefined
        ? event.inputId === undefined || !entry.inputIds.includes(event.inputId)
        : entry.requestId !== event.requestId);
    }
  }
  return inputs.length === 0 && withdrawals.length === 0 && dispatches.length === 0 ? undefined : { inputs, withdrawals, dispatches };
}

/** An accepted dispatch supersedes any rejected carried attempt made by a terminal observer. */
export function dispatchStatus(queue: AdapterQueueState | undefined, reduced: StatusState, record: RawEvent): StatusState {
  const sent = record.kind === "response" && record.body.kind === "accepted"
    ? queue?.dispatches.find(entry => entry.requestId === record.requestId) : undefined;
  if (sent === undefined || sent.ended === true || reduced.pendingPrompt !== undefined || reduced.compactionState !== undefined) { return reduced; }
  return { ...(reduced.kind === "running" ? reduced : {}), kind: "running", requestId: sent.requestId,
    ...(sent.inputIds.length === 1 ? { inputId: sent.inputIds[0] } : {}),
    sinceSeq: reduced.kind === "running" ? reduced.sinceSeq : (sent.seq ?? record.seq),
    phase: reduced.kind === "running" ? reduced.phase : "waiting_model", lastEventAt: record.receivedAt };
}

/** A plain prompt cannot provisionally claim a slot reserved by an adapter-held input. */
export function isHeldOvertake(queue: AdapterQueueState | undefined, record: RawEvent): boolean {
  return queue?.idle !== undefined && record.kind === "request" && record.direction === "toRuntime" && record.body.kind === "prompt"
    && !queue.inputs.some(input => input.accepted === true && record.body.kind === "prompt" && record.body.carries?.includes(input.inputId) === true);
}
