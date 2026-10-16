import { expect, test } from "vitest";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { AgentEvent, SnapshotEvent, TaskId } from "@earendil-works/pi-durable";
import { foldDurableBatch, initialDurableProjection } from "../../packages/oar/src/runtimes/pi-durable/projection.js";

const usage: Usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const empty: SnapshotEvent = { type: "snapshot", entries: [], agent: {}, inbox: [], tools: [], nestedTools: [], compactions: [], usage: { models: {}, tools: {} } };
const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "hello" }], api: "anthropic-messages", provider: "test", model: "model", usage, stopReason: "stop", timestamp: 1 };

function isTaskId(value: number): value is TaskId { return Number.isSafeInteger(value) && value > 0; }

test("nested tool exits preserve native numbers; absent or nonnumeric values stay absent", () => {
  const taskId = 1;
  if (!isTaskId(taskId)) { throw new Error("invalid fixture task id"); }
  for (const exit of [0, 7, 143, undefined, "7"]) {
    const native: AgentEvent[] = [{ type: "tool_execution_end", toolCallId: "outer/bash", toolName: "bash", result: {
      taskId, isError: true, diagnostics: [], durationMs: 1,
      ...(exit === undefined ? {} : { structuredOutput: { exitCode: exit } }),
    } }];
    const { frame } = foldDurableBatch(initialDurableProjection(empty), native);
    expect(frame.events).toEqual([{ kind: "tool_call_ended", callId: "outer/bash", result: "failed",
      ...(typeof exit === "number" ? { exitCode: exit } : {}) }]);
    const json = JSON.stringify(frame);
    expect(JSON.parse(json)).toEqual(frame);
  }
});

test("durable reasoning sums model and tool ledgers and subtracts the attachment baseline", () => {
  const baseline: SnapshotEvent = { ...empty, usage: { models: { first: { ...usage, reasoning: 3 } }, tools: {} } };
  const later: SnapshotEvent = { ...baseline, usage: { models: { first: { ...usage, output: 9, reasoning: 5 }, second: usage }, tools: { embedded: { ...usage, reasoning: 1 } } } };
  const projected = foldDurableBatch(initialDurableProjection(baseline), [later]);
  expect(projected.frame.events).toEqual([{ kind: "usage", usage: { tokens: { input: 30, output: 14, cacheRead: 4, cacheWrite: 6, reasoning: 3 } } }]);
  expect(foldDurableBatch(projected.state, [later]).frame.events).toEqual(projected.frame.events);
  expect(foldDurableBatch(initialDurableProjection(baseline), [baseline]).frame.events).toEqual([{ kind: "usage", usage: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } } }]);
});

test("batched partials and whole blocks project each suffix once", () => {
  const native: AgentEvent[] = [
    { type: "message_start", message },
    { type: "message_update", usage, changes: [
      { type: "text_delta", contentIndex: 0, delta: " world" },
      { type: "block", contentIndex: 0, block: { type: "text", text: "hello world!" } },
      { type: "thinking_start", contentIndex: 1, block: { type: "thinking", thinking: "" } },
      { type: "thinking_delta", contentIndex: 1, delta: "thought" },
      { type: "block", contentIndex: 1, block: { type: "thinking", thinking: "thought" } },
    ] },
  ];
  const next = foldDurableBatch(initialDurableProjection(empty), native);
  expect(next.frame.native).toBe(native);
  expect(next.frame.events).toMatchInlineSnapshot(`
    [
      {
        "kind": "text_delta",
        "text": "hello",
      },
      {
        "kind": "text_delta",
        "text": " world",
      },
      {
        "kind": "text_delta",
        "text": "!",
      },
      {
        "content": {
          "kind": "empty",
        },
        "kind": "reasoning",
      },
      {
        "content": {
          "kind": "text",
          "text": "thought",
        },
        "kind": "reasoning",
      },
    ]
  `);
  const snapshot = { ...empty, generation: { attempt: 0, message: { ...message, content: [{ type: "text" as const, text: "hello world!" }, { type: "thinking" as const, thinking: "thought" }] } } };
  const caughtUp = foldDurableBatch(next.state, [snapshot]);
  expect(caughtUp.frame.native).toEqual([snapshot]);
  expect(caughtUp.frame.events.filter((event) => event.kind === "text_delta" || event.kind === "reasoning")).toEqual([]);
});

test("retained tool output trims, appends and replaces; an absent result stays unknown", () => {
  const snapshot: SnapshotEvent = { ...empty, tools: [{ callId: "call", name: "test", status: "running", output: "abcdef" }] };
  const initial = foldDurableBatch(initialDurableProjection(snapshot), [snapshot]);
  expect(initial.frame.events.filter((event) => event.kind !== "usage")).toMatchInlineSnapshot(`
    [
      {
        "callId": "call",
        "kind": "tool_call_started",
        "tool": "test",
      },
      {
        "callId": "call",
        "kind": "tool_call_progress",
        "output": "abcdef",
      },
    ]
  `);
  const next = foldDurableBatch(initial.state, [
    { type: "tool_execution_update", toolCallId: "call", toolName: "test", output: { trimStart: 3, append: "ghi" } },
    { type: "tool_execution_update", toolCallId: "call", toolName: "test", output: { set: "replacement" } },
    { type: "tool_execution_end", toolCallId: "call", toolName: "test" },
  ]);
  expect(next.frame.events).toMatchInlineSnapshot(`
    [
      {
        "callId": "call",
        "kind": "tool_call_progress",
        "output": "defghi",
      },
      {
        "callId": "call",
        "kind": "tool_call_progress",
        "output": "replacement",
      },
      {
        "callId": "call",
        "kind": "tool_call_ended",
      },
    ]
  `);
});

test("usage starts at attachment and counts native model and tool ledgers once", () => {
  const snapshot: SnapshotEvent = { ...empty, usage: { models: { previous: usage }, tools: {} } };
  const initial = initialDurableProjection(snapshot);
  const later = { ...snapshot, usage: { models: { previous: usage, current: usage }, tools: { embedded: usage } } };
  const next = foldDurableBatch(initial, [later]);
  expect(next.frame.events).toMatchInlineSnapshot(`
    [
      {
        "kind": "usage",
        "usage": {
          "tokens": {
            "cacheRead": 4,
            "cacheWrite": 6,
            "input": 30,
            "output": 10,
          },
        },
      },
    ]
  `);
  expect(foldDurableBatch(next.state, [later]).frame.events).toEqual(next.frame.events);
});

test("native-only and future events remain in their original batch", () => {
  const native: AgentEvent[] = [{ type: "turn_start" }, { type: "inbox_update", items: [] },
    // @ts-expect-error A future SDK event is intentionally outside the pinned union.
    { type: "future_event", payload: "verbatim" },
  ];
  const next = foldDurableBatch(initialDurableProjection(empty), native);
  expect(next.frame.native).toBe(native);
  expect(next.frame.events).toEqual([]);
});
