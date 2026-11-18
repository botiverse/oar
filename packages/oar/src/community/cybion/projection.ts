import type { RuntimeEventBody } from "../../contracts/records.js";
import type { ToolOutputPart } from "../../contracts/tool-output.js";
import { asRecordList, type JsonRecord } from "../../shared/json.js";
import { outputTextOf, type CybionHistoryRecord } from "./thread.js";

/*
 * A Cybion Thread's history is append-only and already the conversation:
 * `input` (a user message), `response_output` (one Responses API output item:
 * a message, a reasoning item, a function call) and `tool_output` (the result
 * of one call, as the Worker answered it). The mapping below reads the kinds
 * it knows and nothing more: an item it does not interpret still enters the
 * stream as a frame with its own `type` and no events, never as a guess.
 */

function messageId(record: CybionHistoryRecord): string {
  const id = record.payload.id;
  return typeof id === "string" && id !== "" ? id : `cybion-record-${String(record.id)}`;
}

function userMessage(record: CybionHistoryRecord): readonly RuntimeEventBody[] {
  const content = record.payload.content;
  const input = typeof content === "string"
    ? content
    : asRecordList(content)
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("");
  return [{ kind: "user_message", input, nativeMessageId: messageId(record), evidence: "conversation" }];
}

function reasoningOf(payload: JsonRecord): string {
  const summary = asRecordList(payload.summary)
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");
  if (summary !== "") {
    return summary;
  }
  return asRecordList(payload.content)
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");
}

function outputEvents(record: CybionHistoryRecord): readonly RuntimeEventBody[] {
  const payload = record.payload;
  switch (payload.type) {
    case "message": {
      const text = outputTextOf(payload);
      return text === "" ? [] : [{ kind: "text_delta", text, messageId: messageId(record) }];
    }
    case "reasoning": {
      const text = reasoningOf(payload);
      const content = text === "" ? { kind: "empty" as const } : { kind: "text" as const, text };
      return [{ kind: "reasoning", content, messageId: messageId(record) }];
    }
    case "function_call":
    case "custom_tool_call": {
      const callId = payload.call_id;
      const tool = payload.name;
      if (typeof callId !== "string" || callId === "" || typeof tool !== "string" || tool === "") {
        return [];
      }
      const input = payload.arguments ?? payload.input;
      return [{
        kind: "tool_call_started",
        callId,
        tool,
        ...(input === undefined ? {} : { input: typeof input === "string" ? input : JSON.stringify(input) }),
      }];
    }
    default:
      return [];
  }
}

function toolOutputPart(output: unknown): ToolOutputPart[] {
  if (typeof output === "string") {
    return [{ type: "text", text: output }];
  }
  return output === undefined ? [] : [{ type: "other", value: output }];
}

function toolOutputEvents(record: CybionHistoryRecord): readonly RuntimeEventBody[] {
  const callId = record.payload.call_id;
  if (typeof callId !== "string" || callId === "") {
    return [];
  }
  const content = toolOutputPart(record.payload.output);
  return [{ kind: "tool_call_ended", callId, ...(content.length === 0 ? {} : { content }) }];
}

/** What oar reads out of one history record, in the record's own terms. */
export function eventsOfHistory(record: CybionHistoryRecord): readonly RuntimeEventBody[] {
  switch (record.kind) {
    case "input":
      return userMessage(record);
    case "response_output":
      return outputEvents(record);
    case "tool_output":
      return toolOutputEvents(record);
    default:
      return [];
  }
}

/** The frame type one history record is recorded under: its own kind and item type. */
export function frameTypeOf(record: CybionHistoryRecord): string {
  const item = record.payload.type;
  return record.kind === "response_output" && typeof item === "string" && item !== ""
    ? `history/${record.kind}/${item}`
    : `history/${record.kind}`;
}
