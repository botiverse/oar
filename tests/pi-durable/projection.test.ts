import assert from "node:assert/strict";
import { expect, test } from "vitest";
import type { Usage } from "@earendil-works/pi-ai-durable";
import type { ConversationId, ConversationView, EntryId, LiveState, SubmissionId, TaskId, WatchCall } from "@earendil-works/pi-durable";
import { appendedEntries, foldDurableView, initialDurableProjection, submissionOutcome } from "../../packages/oar/src/runtimes/pi-durable/projection.js";

function isConversationId(value: number): value is ConversationId { return Number.isSafeInteger(value) && value > 0; }
function isEntryId(value: number): value is EntryId { return Number.isSafeInteger(value) && value > 0; }
function isTaskId(value: number): value is TaskId { return Number.isSafeInteger(value) && value > 0; }
function isSubmissionId(value: number): value is SubmissionId { return Number.isSafeInteger(value) && value > 0; }
const id = 1;
assert.ok(isConversationId(id));
const empty: ConversationView = { conversation: { id }, entries: [], docs: { "pi.live": {}, "pi.agent": {}, "pi.usage": { models: {}, tools: {} } } };
const usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } satisfies Usage;
const message: NonNullable<NonNullable<LiveState["generation"]>["message"]> = { role: "assistant", content: [{ type: "text", text: "hello" }], api: "anthropic-messages", provider: "test", model: "model", usage, stopReason: "stop", timestamp: 1 };
function view(live: LiveState): ConversationView { return { ...empty, docs: { ...empty.docs, "pi.live": live } }; }
function call(value: ConversationView): Extract<WatchCall<ConversationView>, { kind: "value" }> { return { kind: "value", value, ops: [], retired: false }; }
function entry(index: number, text: string) {
  assert.ok(isEntryId(index));
  return { id: index, conversationId: empty.conversation.id, kind: "pi.assistant", model: [{ ...message, content: [{ type: "text" as const, text }] }] };
}

test("cumulative native ledgers subtract the attachment baseline without counting repeated state twice", () => {
  const baseline = { ...empty, docs: { ...empty.docs, "pi.usage": { models: { first: { ...usage, reasoning: 3 } }, tools: {} } } };
  const later = { ...baseline, docs: { ...baseline.docs, "pi.usage": { models: { first: { ...usage, output: 9, reasoning: 5 }, second: usage }, tools: { embedded: { ...usage, reasoning: 1 } } } } };
  const next = foldDurableView(initialDurableProjection(baseline), call(later));
  expect(next.frame.events).toEqual([{ kind: "usage", usage: { tokens: { input: 30, output: 14, cacheRead: 4, cacheWrite: 6, reasoning: 3 } } }]);
  expect(foldDurableView(next.state, call(later)).frame.events).toEqual(next.frame.events);
});

test("partials and the completed entry project each text and reasoning suffix once", () => {
  const first = view({ generation: { attempt: 0, message } });
  const initial = foldDurableView(initialDurableProjection(first), call(first), [], true);
  expect(initial.frame.events.filter(event => event.kind === "text_delta")).toEqual([{ kind: "text_delta", text: "hello" }]);
  const longer = view({ generation: { attempt: 0, message: { ...message, content: [{ type: "text", text: "hello world" }, { type: "thinking", thinking: "thought" }] } } });
  const next = foldDurableView(initial.state, call(longer));
  expect(next.frame.events.filter(event => event.kind !== "usage")).toEqual([{ kind: "text_delta", text: " world" }, { kind: "reasoning", content: { kind: "text", text: "thought" } }]);
  const done = { ...empty, entries: [{ ...entry(5, "hello world!"), model: [{ ...message, content: [{ type: "text" as const, text: "hello world!" }, { type: "thinking" as const, thinking: "thought" }] }] }] };
  const final = foldDurableView(next.state, call(done));
  expect(final.frame.events.filter(event => event.kind !== "usage")).toEqual([{ kind: "text_delta", text: "!" }]);
  expect(foldDurableView(final.state, call(done)).frame.events.filter(event => event.kind !== "usage")).toEqual([]);
});

test("attachment history and native corrections are retained without replaying old text", () => {
  const initial = { ...empty, entries: [entry(5, "history")] };
  const first = foldDurableView(initialDurableProjection(initial), call(initial), [], true);
  expect(first.frame.events.filter(event => event.kind === "text_delta")).toEqual([]);
  const partial = foldDurableView(first.state, call({ ...initial, docs: view({ generation: { attempt: 0, message } }).docs }));
  const correction = call({ ...initial, docs: view({ generation: { attempt: 0, message: { ...message, content: [{ type: "text", text: "corrected" }] } } }).docs });
  const result = foldDurableView(partial.state, correction);
  expect(result.frame.native).toBe(correction);
  expect(result.frame.events.filter(event => event.kind === "text_delta")).toEqual([]);
});

test("tool output is the native retained window, and an absent terminal result remains unknown", () => {
  const first = view({ tools: [{ callId: "call", name: "tool", status: "running", output: "abcdef" }] });
  const initial = foldDurableView(initialDurableProjection(first), call(first), [], true);
  expect(initial.frame.events.filter(event => event.kind !== "usage")).toEqual([{ kind: "tool_call_started", callId: "call", tool: "tool" }, { kind: "tool_call_progress", callId: "call", output: "abcdef" }]);
  const next = foldDurableView(initial.state, call(view({ tools: [{ callId: "call", name: "tool", status: "running", output: "defghi" }] })));
  expect(next.frame.events.filter(event => event.kind !== "usage")).toEqual([{ kind: "tool_call_progress", callId: "call", output: "defghi" }]);
  const end = foldDurableView(next.state, call(view({ tools: [{ callId: "call", name: "tool", status: "done" }] })));
  expect(end.frame.events.filter(event => event.kind !== "usage")).toEqual([{ kind: "tool_call_ended", callId: "call" }]);
});

test("entry appends survive an immediate native window trim in the same notification", () => {
  const entries = Array.from({ length: 110 }, (_, index) => entry(index + 5, String(index)));
  const native: Extract<WatchCall<ConversationView>, { kind: "value" }> = { ...call({ ...empty, entries: entries.slice(-50) }), ops: [["p", ["entries"], 0, 0, entries], ["p", ["entries"], 0, 60, []]] };
  expect(appendedEntries(empty, native)).toEqual(entries);
  expect(foldDurableView(initialDurableProjection(empty), native).frame.events.filter(event => event.kind === "text_delta")).toHaveLength(110);
});

test("unknown native documents and operations remain in the original frame", () => {
  const native = call({ ...empty, docs: { ...empty.docs, future: { untouched: true } } });
  const next = foldDurableView(initialDurableProjection(empty), native);
  expect(next.frame.native).toBe(native);
  const serialized = JSON.stringify(next.frame.native);
  const persisted: unknown = JSON.parse(serialized);
  expect(persisted).toEqual(native);
});

test("a missing terminal receipt cannot turn a partly answered run into completion", () => {
  const submissionId = 9;
  const answer = 11;
  assert.ok(isSubmissionId(submissionId));
  assert.ok(isEntryId(answer));
  expect(submissionOutcome([{ id: submissionId, conversationId: empty.conversation.id, type: "input", status: "done", entry: answer, answer }, undefined])).toBeUndefined();
  expect(submissionOutcome([])).toBeUndefined();
});

test("unrelated assistant entries do not consume the current generation's partial prefix", () => {
  const taskId = 10;
  assert.ok(isTaskId(taskId));
  const first = view({ run: { taskId, inputs: [], turns: 0 }, generation: { attempt: 0, message } });
  const initial = foldDurableView(initialDurableProjection(first), call(first), [], true);
  const written = { ...first, entries: [entry(12, "external assistant message")] };
  const next = foldDurableView(initial.state, call(written));
  expect(next.frame.events.filter(event => event.kind === "text_delta")).toEqual([{ kind: "text_delta", text: "external assistant message" }]);
  const end = foldDurableView(next.state, call({ ...empty, entries: [...written.entries, { ...entry(13, "hello!"), byTaskId: taskId }] }));
  expect(end.frame.events.filter(event => event.kind === "text_delta")).toEqual([{ kind: "text_delta", text: "!" }]);
});

test("a new generation attempt can repeat the same text without being mistaken for an old partial", () => {
  const first = view({ generation: { attempt: 0, message } });
  const initial = foldDurableView(initialDurableProjection(first), call(first), [], true);
  const next = foldDurableView(initial.state, call(view({ generation: { attempt: 1, message } })));
  expect(next.frame.events.filter(event => event.kind === "text_delta")).toEqual([{ kind: "text_delta", text: "hello" }]);
});
