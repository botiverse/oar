import type { RuntimeEventBody } from "../../contracts/session.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";

interface MessageObservation {
  readonly threadId: string;
  readonly turnId: string | null;
  readonly phase?: string;
  readonly streamed: boolean;
  readonly completed: boolean;
}

/** Message evidence is scoped by native thread, turn and item, never by text or arrival order. */
export type CodexMessages = ReadonlyMap<string, MessageObservation>;

export function foldCodexMessages(
  previous: CodexMessages, threadId: string, method: string, params: JsonRecord,
): { readonly messages: CodexMessages; readonly events: readonly RuntimeEventBody[] } {
  const turnId = typeof params.turnId === "string" ? params.turnId : null;
  if (method === "turn/completed") {
    const ended = asRecord(params.turn)?.id;
    return { messages: new Map([...previous].filter(([, value]) => value.threadId !== threadId || (value.turnId !== ended && value.turnId !== null))), events: [] };
  }
  const item = asRecord(params.item);
  const delta = method === "item/agentMessage/delta";
  const lifecycle = (method === "item/started" || method === "item/completed") && item?.type === "agentMessage";
  if (!delta && !lifecycle) { return { messages: previous, events: [] }; }
  const id = delta ? params.itemId : item?.id;
  const messageId = typeof id === "string" ? id : undefined;
  const key = messageId === undefined ? undefined : JSON.stringify([threadId, turnId, messageId]);
  const known = key === undefined ? undefined : previous.get(key);
  // Deltas carry no phase. Only that same item's earlier native report can supply it.
  const phase = delta ? known?.phase : (typeof item?.phase === "string" ? item.phase : undefined);
  const events: RuntimeEventBody[] = [];
  const text = delta ? params.delta : (method === "item/completed" ? item?.text : undefined);
  if (typeof text === "string" && (delta || (text.length > 0 && known?.streamed !== true && known?.completed !== true))) {
    events.push({ kind: "text_delta", text,
      ...(messageId === undefined ? {} : { messageId }), ...(phase === undefined ? {} : { phase }),
    });
  }
  if (key === undefined) { return { messages: previous, events }; }
  const messages = new Map([...previous, [key, {
    threadId, turnId, ...(phase === undefined ? {} : { phase }),
    streamed: known?.streamed === true || (delta && typeof text === "string" && text.length > 0),
    completed: known?.completed === true || method === "item/completed",
  }]]);
  return { messages, events };
}
