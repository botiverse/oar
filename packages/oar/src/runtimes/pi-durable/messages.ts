import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { RuntimeEventBody } from "../../contracts/session.js";

export interface MessageProjection {
  readonly blocks: ReadonlyMap<number, { readonly kind: "text" | "thinking"; readonly text: string }>;
}
export const emptyMessage: MessageProjection = { blocks: new Map() };

/** Whole blocks include text already delivered as deltas. Emit only the observed suffix. */
export function wholeMessage(previous: MessageProjection, message: AssistantMessage): { readonly state: MessageProjection; readonly events: readonly RuntimeEventBody[] } {
  let state = previous;
  const events: RuntimeEventBody[] = [];
  for (const [index, block] of message.content.entries()) {
    const next = wholeBlock(state, index, block);
    state = next.state;
    events.push(...next.events);
  }
  return { state, events };
}

function textEvent(kind: "text" | "thinking", text: string): RuntimeEventBody {
  return kind === "text" ? { kind: "text_delta", text } : { kind: "reasoning", content: text === "" ? { kind: "empty" } : { kind: "text", text } };
}

function wholeBlock(previous: MessageProjection, index: number, block: AssistantMessage["content"][number]): { readonly state: MessageProjection; readonly events: readonly RuntimeEventBody[] } {
  if (block.type === "toolCall") { return { state: previous, events: [] }; }
  const text = block.type === "text" ? block.text : block.thinking;
  const before = previous.blocks.get(index);
  const prefix = before?.kind === block.type ? before.text : "";
  const blocks = new Map(previous.blocks).set(index, { kind: block.type, text });
  // OAR has no text replacement event. A native correction stays in the raw frame,
  // never appended as a second copy or disguised as an invented delta.
  const suffix = text.startsWith(prefix) ? text.slice(prefix.length) : "";
  const events = suffix !== "" || (block.type === "thinking" && before === undefined) ? [textEvent(block.type, suffix)] : [];
  return { state: { blocks }, events };
}
