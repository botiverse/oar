import type { Cursor, RawEventObserver, Session, Unsubscribe } from "../contracts/session.js";

/** Stateful projections read the retained prefix to reconstruct their state. Only the suffix reaches the caller. */
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
