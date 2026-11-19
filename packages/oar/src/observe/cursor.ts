import type { Cursor, RawEvent, RawEventObserver, Session, Unsubscribe } from "../contracts/session.js";

/** Readers reconstruct their state from the retained log using the subscription boundary. */
export function observeWithPrefix(
  session: Pick<Session, "id" | "records" | "rawEvents">,
  cursor: Cursor | undefined,
  reader: (afterSeq: number) => RawEventObserver,
): Unsubscribe {
  if (cursor !== undefined && cursor.sessionId !== session.id) {
    throw new Error(`cursor belongs to session ${cursor.sessionId}, not ${session.id}`);
  }
  const afterSeq = cursor?.afterSeq ?? session.records().at(-1)?.seq ?? -1;
  return session.rawEvents(reader(afterSeq), { sessionId: session.id, afterSeq: -1 });
}

/** With no cursor, publish the folded snapshot at the end of a nonempty prefix, then each live update. */
export function observeState<State>(
  session: Session,
  cursor: Cursor | undefined,
  initial: State,
  reduce: (state: State, record: RawEvent) => State,
  observer: (state: State) => void,
): Unsubscribe {
  let state = initial;
  return observeWithPrefix(session, cursor, afterSeq => record => {
    state = reduce(state, record);
    if (record.seq > afterSeq || (cursor === undefined && record.seq === afterSeq)) { observer(state); }
  });
}
