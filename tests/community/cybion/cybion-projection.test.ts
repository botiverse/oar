import { describe, expect, it } from "vitest";
import { eventsOfHistory, frameTypeOf } from "../../../packages/oar/src/community/cybion/projection.js";
import type { CybionHistoryRecord } from "../../../packages/oar/src/community/cybion/thread.js";

function record(kind: string, payload: Record<string, unknown>, id = 1): CybionHistoryRecord {
  return { native: { id, kind, payload }, id, kind, payload };
}

describe("cybion history projection", () => {
  it("reads a user input as a user message", () => {
    expect(eventsOfHistory(record("input", { role: "user", content: "hello" }))).toEqual([
      { kind: "user_message", input: "hello", nativeMessageId: "cybion-record-1", evidence: "conversation" },
    ]);
  });

  it("reads an assistant message as one text delta named by its item id", () => {
    const message = record("response_output", {
      type: "message",
      id: "msg_1",
      role: "assistant",
      content: [
        { type: "output_text", text: "wor" },
        { type: "output_text", text: "ld" },
      ],
    });
    expect(eventsOfHistory(message)).toEqual([{ kind: "text_delta", text: "world", messageId: "msg_1" }]);
  });

  it("reads a reasoning item, readable or not, without inventing text", () => {
    expect(eventsOfHistory(record("response_output", { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thinking" }] })))
      .toEqual([{ kind: "reasoning", content: { kind: "text", text: "thinking" }, messageId: "rs_1" }]);
    expect(eventsOfHistory(record("response_output", { type: "reasoning", id: "rs_2" })))
      .toEqual([{ kind: "reasoning", content: { kind: "empty" }, messageId: "rs_2" }]);
  });

  it("reads a function call with its reported arguments", () => {
    const call = record("response_output", {
      type: "function_call",
      call_id: "call_1",
      name: "bash",
      arguments: JSON.stringify({ command: "ls" }),
    });
    expect(eventsOfHistory(call)).toEqual([{ kind: "tool_call_started", callId: "call_1", tool: "bash", input: "{\"command\":\"ls\"}" }]);
  });

  it("reads a custom tool call from its input field", () => {
    const call = record("response_output", { type: "custom_tool_call", call_id: "call_2", name: "apply", input: "raw" });
    expect(eventsOfHistory(call)).toEqual([{ kind: "tool_call_started", callId: "call_2", tool: "apply", input: "raw" }]);
  });

  it("reads a tool output as the end of its call", () => {
    expect(eventsOfHistory(record("tool_output", { call_id: "call_1", output: "ok" })))
      .toEqual([{ kind: "tool_call_ended", callId: "call_1", content: [{ type: "text", text: "ok" }] }]);
  });

  it("keeps a structured tool output whole as an unread part", () => {
    const output = { content: [{ type: "text", text: "ok" }] };
    expect(eventsOfHistory(record("tool_output", { call_id: "call_1", output })))
      .toEqual([{ kind: "tool_call_ended", callId: "call_1", content: [{ type: "other", value: output }] }]);
  });

  it("reads nothing from a record it does not interpret, and still names its frame", () => {
    const activity = record("activity", { type: "context", content: "background" });
    expect(eventsOfHistory(activity)).toEqual([]);
    expect(frameTypeOf(activity)).toBe("history/activity");
    expect(frameTypeOf(record("response_output", { type: "message" }))).toBe("history/response_output/message");
  });
});
