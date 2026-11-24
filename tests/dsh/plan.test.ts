import assert from "node:assert/strict";
import { expect, test } from "vitest";
import rc from "../../experiments/dsh-plugin/evidence/0.2.1-rc.5.json" with { type: "json" };
import type { RuntimeEventBody } from "../../packages/oar/src/contracts/session.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { foldDsh, initialDshProjection } from "../../packages/oar/src/runtimes/dsh/projection.js";

/**
 * DSH has no plan channel of its own: the only native checklist is the
 * model's `todo_write` call, whose `todos` argument is the whole list
 * ([env] the tool schema in the captured request header below). The call
 * itself still reads as `tool_call_started`; the checklist is a second fact
 * on the same frame, marked `evidence: "tool_call"`.
 */
function toolCall(data: JsonRecord, sessionId = "root"): JsonRecord {
  return { type: "native", channel: "session/event", sessionId, event: { type: "tool/call", seq: 3, time: 1, data } };
}

function read(line: JsonRecord): { readonly frame: ReturnType<typeof foldDsh>["frame"]; readonly events: readonly RuntimeEventBody[] } {
  const { frame } = foldDsh(initialDshProjection("root"), line);
  return { frame, events: frame.body.events };
}

const todoCall = (todos: unknown, callId = "todo-1"): JsonRecord =>
  toolCall({ turn: 1, step: 1, callId, name: "todo_write", arguments: JSON.stringify({ todos }) });

/** The provider request header a captured frame carries, when it is that frame. */
function headerOf(frame: unknown): JsonRecord {
  const event = asRecord(asRecord(frame)?.event);
  const data = asRecord(event?.data);
  return asRecord(data?.header) ?? {};
}

test("the captured DSH tool schema is the shape the checklist is read from", () => {
  const tools = rc.basicNativeFrames.map(headerOf).flatMap((header) => {
    const reported: unknown = header.tools;
    return Array.isArray(reported) ? reported.map((tool: unknown) => tool) : [];
  });
  const schema = tools.map((tool: unknown) => asRecord(tool)).find((tool) => tool?.name === "todo_write");
  const properties = asRecord(asRecord(schema?.parameters)?.properties);
  expect(asRecord(properties?.todos)?.description).toContain("COMPLETE task list, replacing any previous list");
  const items = asRecord(asRecord(properties?.todos)?.items);
  expect(items?.required).toEqual(["content", "status"]);
  expect(asRecord(asRecord(items?.properties)?.status)?.enum).toEqual(["pending", "in_progress", "completed"]);
});

test("a DSH todo_write call reads as the call plus one whole-list plan_changed", () => {
  const line = todoCall([{ content: "Read the wire shape", status: "in_progress" }, { content: "Write the spec", status: "pending" }]);
  const { events, frame } = read(line);
  expect(events).toEqual([
    { kind: "tool_call_started", callId: "todo-1", tool: "todo_write", input: JSON.stringify({ todos: [{ content: "Read the wire shape", status: "in_progress" }, { content: "Write the spec", status: "pending" }] }) },
    { kind: "plan_changed", evidence: "tool_call", callId: "todo-1", plan: { steps: [
      { step: "Read the wire shape", status: "in_progress" },
      { step: "Write the spec", status: "pending" },
    ] } },
  ]);
  // The frame keeps the native tool call untouched, and drops nothing else.
  expect(frame.body.native).toEqual(asRecord(line.event));
  expect(frame.body.type).toBe("session/event:tool/call");
});

test("an empty todos list is the model's own clear; other tools, unreadable arguments and streamed deltas yield no plan", () => {
  expect(read(todoCall([])).events.filter((event) => event.kind === "plan_changed"))
    .toEqual([{ kind: "plan_changed", evidence: "tool_call", callId: "todo-1", plan: { steps: [] } }]);
  // Not the checklist tool: only the call is read.
  expect(read(toolCall({ callId: "bash-1", name: "bash", arguments: '{"todos":[]}' })).events.map((event) => event.kind)).toEqual(["tool_call_started"]);
  // Arguments that do not parse, no todos, or an item without content/status: the frame stays native only.
  for (const argumentsText of ["not json", '{"value":1}', '{"todos":[{"content":"no status"}]}', '{"todos":"all"}']) {
    expect(read(toolCall({ callId: "todo-2", name: "todo_write", arguments: argumentsText })).events.map((event) => event.kind)).toEqual(["tool_call_started"]);
  }
  // The streamed argument delta is not the complete list: only the call frame says what the model chose.
  const delta = read({ type: "native", channel: "agent/assistant-stream", sessionId: "root", frame: { type: "chunk", chunk: { type: "tool-call-delta", id: "todo-3", argumentsDelta: '{"todos":[{"content":"partial"' } } });
  expect(delta.events.filter((event) => event.kind === "plan_changed")).toEqual([]);
  // A status word oar does not know stays visible unchanged.
  expect(read(todoCall([{ content: "future", status: "deferred" }])).events.at(-1)).toMatchObject({ plan: { steps: [{ step: "future", status: "deferred" }] } });
});

test("a checklist in a child session keeps that session's attribution and adds no transcript message", () => {
  const { frame } = read(toolCall({ turn: 1, step: 1, callId: "todo-child", name: "todo_write", arguments: '{"todos":[{"content":"Child step","status":"pending"}]}' }, "child"));
  expect(frame.sessionId).toBe("child");
  const plan = frame.body.events.filter((event) => event.kind === "plan_changed");
  expect(plan).toEqual([{ kind: "plan_changed", evidence: "tool_call", callId: "todo-child", plan: { steps: [{ step: "Child step", status: "pending" }] } }]);
  assert.ok(!frame.body.events.some((event) => event.kind === "user_message" || event.kind === "text_delta" || event.kind === "task_started"));
});
