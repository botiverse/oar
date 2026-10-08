import { awaitsEcho, deliveryState, withDeliveryState, type InputDrop } from "./input-delivery.js";
import type { Cursor, Event, InputImage, InputOrigin, RawEvent, RequestRecord, ResponseRecord, Session, Unsubscribe, UserMessage } from "../contracts/session.js";
import { eventsOf, type KnownControl } from "./events.js";

export interface InputAttempt {
  /** A delivery attempt (prompt, steer, queue) or a withdraw of the input. */
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
  /** The images the input carried (`InputOptions.images`), from its latest request; absent when none. A UI shows them with the text. */
  readonly images?: readonly InputImage[];
  /** Who the input came from (`InputOptions.origin`), from its latest request; absent when the host said nothing. */
  readonly origin?: InputOrigin;
  /** `withdrawn`: an accepted withdraw took the held input back before it was sent, and no delivery attempt followed it. */
  readonly state: "pending" | "accepted" | "rejected" | "withdrawn" | "dropped" | "untracked";
  /** Present only for dropped input. runtime_exited means no echo was observed before exit, not proof it was never read. */
  readonly reason?: "turn_interrupted" | "runtime_exited";
  /** Every request that targeted the input, in fold order: delivery attempts and withdraws, each with its observed response. */
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
  /** Number of attempts settled by the latest drop; later attempts can take ownership again. */
  readonly drops: ReadonlyMap<string, InputDrop>;
  readonly actions: ReadonlyMap<string, KnownControl>;
  readonly cursors: ReadonlyMap<string, number>;
  /** Changes produced by this record, in record order; use for incremental UI updates. */
  readonly updates: readonly ConversationUpdate[];
}
export function initialConversation(): ConversationState {
  return { drops: new Map(), inputs: new Map(), requests: new Map(), actions: new Map(), cursors: new Map(), updates: [] };
}
function identity(record: RawEvent, id: string): string {
  return JSON.stringify([record.sessionId, record.agentPath, id]);
}
/** One ordered stream per streamId. Use a new streamId after runtime resume (seq restarts).
 * Input UUIDs/native message IDs can still connect observations across those streams.
 * Missing IDs never fall back to text matching. Unlinked user messages remain event updates.
 */
export function reduceConversation(previous: ConversationState, record: RawEvent, streamId = ""): ConversationState {
  if (record.seq <= (previous.cursors.get(streamId) ?? -1)) {return { ...previous, updates: [] };}
  const inputs = new Map(previous.inputs);
  const drops = new Map(previous.drops);
  const requests = new Map(previous.requests);
  const actions = new Map(previous.actions);
  const cursors = new Map([...previous.cursors, [streamId, record.seq] as const]);
  const updates: ConversationUpdate[] = [];
  const operationKey = (id: string): string => JSON.stringify([streamId, identity(record, id)]);
  const publish = (input: ConversationInput): void => { inputs.set(input.id, input); updates.push({ kind: "input", input }); };
  let handled = false;
  if (record.kind === "request" && record.direction === "toRuntime" && record.body.kind !== "native") {
    actions.set(operationKey(record.id), record.body.kind === "withdraw" ? record.body : record.body.kind);
    const target = record.body.kind === "withdraw" ? inputs.get(identity(record, record.body.inputId)) : undefined;
    if (target !== undefined && target.attempts.length > 0) {
      // A withdraw is an attempt on the input it targets, never a bubble of its own.
      const attempts: readonly InputAttempt[] = [...target.attempts, { request: record, streamId, state: "pending" }];
      requests.set(operationKey(record.id), target.id);
      publish(withDeliveryState(target, attempts, drops.get(target.id)));
      handled = true;
    } else if ("input" in record.body) {
      const { input, inputId, images, origin } = record.body;
      const id = inputId === undefined ? operationKey(record.id) : identity(record, inputId);
      const existing = inputs.get(id);
      const attempts: readonly InputAttempt[] = [...(existing?.attempts ?? []), { request: record, streamId, state: "pending" }];
      requests.set(operationKey(record.id), id);
      publish({ id, input, ...(inputId === undefined ? {} : { inputId }), ...(images === undefined || images.length === 0 ? {} : { images }), ...(origin === undefined ? {} : { origin }), attempts,
        ...deliveryState(attempts, drops.get(id)), observations: existing?.observations ?? [] });
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
      publish(withDeliveryState(input, attempts, drops.get(input.id)));
      handled = true;
    }
  }
  if (record.kind === "response" && record.body.kind === "exited") {
    for (const input of inputs.values()) {
      const last = input.attempts.at(-1);
      if (last?.streamId !== streamId || last.request.sessionId !== record.sessionId
        || !record.agentPath.every((part, index) => last.request.agentPath[index] === part)
        || !awaitsEcho(input, { inputs })) { continue; }
      const drop: InputDrop = { attempts: input.attempts.length, reason: "runtime_exited" };
      drops.set(input.id, drop);
      publish(withDeliveryState(input, input.attempts, drop));
    }
  }
  if (!handled) {
    const control = new Map<string, KnownControl>();
    if (record.kind === "response") {
      const action = actions.get(operationKey(record.requestId));
      if (action !== undefined) {control.set(record.requestId, action);}
    }
    for (const event of eventsOf(record, control)) {
      if (event.kind === "input_dropped") {
        const input = inputs.get(identity(record, event.inputId));
        if (input === undefined) { updates.push({ kind: "event", event }); continue; }
        const drop: InputDrop = { attempts: input.attempts.length, reason: event.reason };
        drops.set(input.id, drop);
        publish(withDeliveryState(input, input.attempts, drop));
      } else if (event.kind === "user_message" && event.inputId !== undefined) {
        const id = identity(record, event.inputId);
        const input = inputs.get(id) ?? { id, inputId: event.inputId, input: event.input, state: "untracked" as const, attempts: [], observations: [] };
        const alreadySeen = event.nativeMessageId !== undefined && input.observations.some((observation) => observation.nativeMessageId === event.nativeMessageId && observation.evidence === event.evidence);
        if (alreadySeen) { continue; }
        // Exit proves only that no echo arrived before death. A resumed
        // transcript can supply the missing evidence without a new attempt.
        const drop = drops.get(id);
        const restored = drop?.reason === "runtime_exited" && drop.attempts === input.attempts.length;
        if (restored) { drops.delete(id); }
        const current = restored ? withDeliveryState(input, input.attempts) : input;
        publish({ ...current, observations: [...input.observations, event] });
      } else {
        updates.push({ kind: "event", event });
      }
    }
  }
  if (record.kind === "response") {actions.delete(operationKey(record.requestId));}
  return { drops, inputs, requests, actions, cursors, updates };
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
