import type { RuntimeEventBody } from "../../contracts/session.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";

interface PartialBlock {
  readonly type: "text" | "thinking";
  readonly text: string;
  readonly finalized: boolean;
}
interface PartialMessage {
  readonly id?: string;
  readonly blocks: ReadonlyMap<number, PartialBlock>;
}
/** Only unfinished API messages, per agent lane. Children can stream while root is idle. */
export type ClaudePartials = ReadonlyMap<string, PartialMessage>;

export function contentBlocks(message: JsonRecord): readonly JsonRecord[] {
  const content = asRecord(message.message)?.content;
  return Array.isArray(content) ? content.map((block) => asRecord(block)).filter((block) => block !== null) : [];
}

function textEvent(type: "text" | "thinking", text: string, id?: string): RuntimeEventBody {
  const identity = id === undefined ? {} : { messageId: id };
  return type === "text"
    ? { kind: "text_delta", text, ...identity }
    : { kind: "reasoning", content: { kind: "text", text }, ...identity };
}

/** Partial frames never start a tool: its full input still comes from assistant. */
function streamContent(previous: PartialMessage | undefined, event: JsonRecord): { message: PartialMessage | undefined; events: RuntimeEventBody[] } {
  if (event.type === "message_start") {
    const id = asRecord(event.message)?.id;
    return { message: { ...(typeof id === "string" ? { id } : {}), blocks: new Map() }, events: [] };
  }
  const message = previous ?? { blocks: new Map<number, PartialBlock>() };
  const body = event.type === "content_block_start" ? asRecord(event.content_block)
    : (event.type === "content_block_delta" ? asRecord(event.delta) : null);
  const type = body?.type === "text" || body?.type === "text_delta" ? "text"
    : (body?.type === "thinking" || body?.type === "thinking_delta" ? "thinking" : null);
  if (type === null || typeof event.index !== "number") {
    return { message: previous, events: [] };
  }
  const value = body?.[type];
  const text = typeof value === "string" ? value : "";
  const blocks = new Map(message.blocks);
  const prior = event.type === "content_block_start" ? undefined : blocks.get(event.index);
  blocks.set(event.index, { type, text: (prior?.text ?? "") + text, finalized: false });
  return { message: { ...message, blocks }, events: text.length === 0 ? [] : [textEvent(type, text, message.id)] };
}

/** Native 2.1.293 emits one completed block just before its content_block_stop,
 * with the same API id for every block. Consume that block's streamed prefix
 * once, rather than treating an entire message id as already projected. */
function finalContent(message: JsonRecord, partial: PartialMessage | undefined): { message: PartialMessage | undefined; events: RuntimeEventBody[] } {
  const id = asRecord(message.message)?.id;
  const identity = typeof id === "string" ? { messageId: id } : {};
  const blocks = new Map(partial?.blocks);
  const remainder = (type: "text" | "thinking", full: string): string | null => {
    if (typeof id !== "string" || partial?.id !== id) {
      return full;
    }
    const pending = [...blocks].find(([, block]) => block.type === type && !block.finalized);
    if (pending === undefined) {
      return full;
    }
    const [index, block] = pending;
    blocks.set(index, { ...block, finalized: true });
    if (block.text.length === 0 || !full.startsWith(block.text)) {
      return full;
    }
    const suffix = full.slice(block.text.length);
    return suffix.length === 0 ? null : suffix;
  };
  const events: RuntimeEventBody[] = [];
  for (const block of contentBlocks(message)) {
    switch (block.type) {
      case "text": {
        const text = typeof block.text === "string" ? remainder("text", block.text) : null;
        if (text !== null) { events.push({ kind: "text_delta", text, ...identity }); }
        break;
      }
      case "thinking": {
        const text = remainder("thinking", typeof block.thinking === "string" ? block.thinking : "");
        if (text !== null) {
          events.push({ kind: "reasoning", content: text.length > 0 ? { kind: "text", text } : { kind: "empty" }, ...identity });
        }
        break;
      }
      case "redacted_thinking":
        events.push({ kind: "reasoning", content: { kind: "redacted" }, ...identity });
        break;
      case "tool_use": {
        events.push({
          kind: "tool_call_started",
          callId: typeof block.id === "string" ? block.id : "unknown",
          tool: typeof block.name === "string" ? block.name : "unknown",
          ...(block.input === undefined ? {} : { input: JSON.stringify(block.input) }),
        });
        break;
      }
      default:
        break;
    }
  }
  return { message: partial === undefined ? undefined : { ...partial, blocks }, events };
}

/** Pure content projection; the caller records the original frame even if events is empty. */
export function claudeContent(partials: ClaudePartials, message: JsonRecord, agentPath: readonly string[]): { partials: ClaudePartials; events: RuntimeEventBody[] } {
  const lane = JSON.stringify(agentPath);
  if (message.type === "stream_event" && asRecord(message.event)?.type === "message_stop") {
    // Every completed assistant block precedes this native boundary. Only
    // this agent is done; other agents may still have partial output pending.
    const remaining = new Map(partials);
    remaining.delete(lane);
    return { partials: remaining, events: [] };
  }
  const previous = partials.get(lane);
  const next = message.type === "stream_event"
    ? streamContent(previous, asRecord(message.event) ?? {})
    : finalContent(message, previous);
  return { partials: next.message === undefined ? partials : new Map([...partials, [lane, next.message]]), events: next.events };
}
