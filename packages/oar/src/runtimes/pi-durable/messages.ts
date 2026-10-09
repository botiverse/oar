import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { MessageChange } from "@earendil-works/pi-durable";
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
  // OAR has no text replacement event. A native correction stays in the raw batch,
  // never appended as a second copy or disguised as an invented delta.
  const suffix = text.startsWith(prefix) ? text.slice(prefix.length) : "";
  const events = suffix !== "" || (block.type === "thinking" && before === undefined) ? [textEvent(block.type, suffix)] : [];
  return { state: { blocks }, events };
}

export function messageChanges(previous: MessageProjection, changes: readonly MessageChange[]): { readonly state: MessageProjection; readonly events: readonly RuntimeEventBody[] } {
  let state = previous;
  const events: RuntimeEventBody[] = [];
  for (const change of changes) {
    const next = messageChange(state, change);
    state = next.state;
    events.push(...next.events);
  }
  return { state, events };
}

function messageChange(state: MessageProjection, change: MessageChange): { readonly state: MessageProjection; readonly events: readonly RuntimeEventBody[] } {
  switch (change.type) {
    case "message": return wholeMessage(state, change.message);
    case "text_start":
    case "thinking_start":
    case "toolcall_start":
    case "block": return wholeBlock(state, change.contentIndex, change.block);
    case "text_delta":
    case "thinking_delta": {
      const kind = change.type === "text_delta" ? "text" : "thinking";
      const text = (state.blocks.get(change.contentIndex)?.text ?? "") + change.delta;
      return { state: { blocks: new Map(state.blocks).set(change.contentIndex, { kind, text }) }, events: change.delta === "" ? [] : [textEvent(kind, change.delta)] };
    }
    case "toolcall_delta": return { state, events: [] };
  }
  return { state, events: [] };
}
