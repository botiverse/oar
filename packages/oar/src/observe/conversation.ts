import type { ControlAction, Cursor, Event, RawEvent, RequestRecord, ResponseRecord, Session, Unsubscribe, UserMessage } from "../contracts/session.js";
import { eventsOf } from "./events.js";

export interface InputAttempt {
  readonly request: RequestRecord;
  readonly streamId: string;
  readonly response?: ResponseRecord;
  readonly state: "pending" | "accepted" | "rejected";
  readonly reason?: string;
}
export interface ConversationInput {
  /** Stable projection key, scoped to native session and agent lineage. */
  readonly id: string;
  readonly inputId?: string;
  readonly input: string;
  readonly state: "pending" | "accepted" | "rejected" | "untracked";
  readonly attempts: readonly InputAttempt[];
  /** Native observations; none of these alone proves model consumption. */
  readonly observations: readonly (UserMessage & { readonly seq: number })[];
}
export type ConversationUpdate =
  | { readonly kind: "input"; readonly input: ConversationInput }
  | { readonly kind: "event"; readonly event: Event };
export interface ConversationState {
  readonly inputs: ReadonlyMap<string, ConversationInput>;
  readonly requests: ReadonlyMap<string, string>;
  readonly actions: ReadonlyMap<string, ControlAction>;
  readonly cursors: ReadonlyMap<string, number>;
  /** Changes produced by this record, in record order; use for incremental UI updates. */
  readonly updates: readonly ConversationUpdate[];
}
export function initialConversation(): ConversationState {
  return { inputs: new Map(), requests: new Map(), actions: new Map(), cursors: new Map(), updates: [] };
}
function identity(record: RawEvent, id: string): string {
  return JSON.stringify([record.sessionId, record.agentPath, id]);
}
function inputState(attempts: readonly InputAttempt[]): ConversationInput["state"] {
  if (attempts.some((attempt) => attempt.state === "accepted")) {return "accepted";}
  return attempts.at(-1)?.state ?? "pending";
}

/** One ordered stream per streamId. Use a new streamId after runtime resume (seq restarts).
 * Input UUIDs/native message IDs can still connect observations across those streams.
 * Missing IDs never fall back to text matching. Unlinked user messages remain event updates.
 */
export function reduceConversation(previous: ConversationState, record: RawEvent, streamId = ""): ConversationState {
  if (record.seq <= (previous.cursors.get(streamId) ?? -1)) {return { ...previous, updates: [] };}
  const inputs = new Map(previous.inputs);
  const requests = new Map(previous.requests);
  const actions = new Map(previous.actions);
  const cursors = new Map([...previous.cursors, [streamId, record.seq] as const]);
  const updates: ConversationUpdate[] = [];
  const operationKey = (id: string): string => JSON.stringify([streamId, identity(record, id)]);
  const publish = (input: ConversationInput): void => { inputs.set(input.id, input); updates.push({ kind: "input", input }); };
  let handled = false;
  if (record.kind === "request" && record.direction === "toRuntime" && record.body.kind !== "native") {
    actions.set(operationKey(record.id), record.body.kind);
    if ("input" in record.body) {
      const { input, inputId } = record.body;
      const id = inputId === undefined ? operationKey(record.id) : identity(record, inputId);
      const existing = inputs.get(id);
      const attempts: readonly InputAttempt[] = [...(existing?.attempts ?? []), { request: record, streamId, state: "pending" }];
      requests.set(operationKey(record.id), id);
      publish({ id, input, ...(inputId === undefined ? {} : { inputId }), attempts,
        state: inputState(attempts), observations: existing?.observations ?? [] });
      handled = true;
    }
  } else if (record.kind === "response") {
    const id = requests.get(operationKey(record.requestId));
    const input = id === undefined ? undefined : inputs.get(id);
    if (input !== undefined && (record.body.kind === "accepted" || record.body.kind === "rejected")) {
      const body = record.body;
      const attempts = input.attempts.map((attempt): InputAttempt => attempt.request.id !== record.requestId || attempt.streamId !== streamId ? attempt : {
        request: attempt.request, streamId, response: record, state: body.kind, ...(body.kind === "rejected" ? { reason: body.reason } : {}),
      });
      publish({ ...input, attempts, state: inputState(attempts) });
      handled = true;
    }
  }
  if (!handled) {
    const control = new Map<string, ControlAction>();
    if (record.kind === "response") {
      const action = actions.get(operationKey(record.requestId));
      if (action !== undefined) {control.set(record.requestId, action);}
    }
    for (const event of eventsOf(record, control)) {
      if (event.kind === "user_message" && event.inputId !== undefined) {
        const id = identity(record, event.inputId);
        const input = inputs.get(id) ?? { id, inputId: event.inputId, input: event.input, state: "untracked" as const, attempts: [], observations: [] };
        const alreadySeen = event.nativeMessageId !== undefined && input.observations.some((observation) => observation.nativeMessageId === event.nativeMessageId && observation.evidence === event.evidence);
        if (!alreadySeen) {publish({ ...input, observations: [...input.observations, event] });}
      } else {
        updates.push({ kind: "event", event });
      }
    }
  }
  if (record.kind === "response") {actions.delete(operationKey(record.requestId));}
  return { inputs, requests, actions, cursors, updates };
}
export function conversationOf(records: readonly RawEvent[]): ConversationState {
  return records.reduce((state, record) => reduceConversation(state, record), initialConversation());
}
export function observeConversation(session: Session, observer: (state: ConversationState) => void, cursor?: Cursor): Unsubscribe {
  let state = initialConversation();
  // Always fold the retained prefix: a cursor can start after an input request.
  return session.rawEvents((record) => {
    state = reduceConversation(state, record);
    if (record.seq > (cursor?.afterSeq ?? -1)) {observer(state);}
  }, { sessionId: session.id, afterSeq: -1 });
}
