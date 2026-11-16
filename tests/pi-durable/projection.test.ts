import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { copyJson } from "@earendil-works/chord/json";
import type { Usage } from "@earendil-works/pi-ai-durable";
import type { ConversationId, ConversationView, EntryId, LiveState, SubmissionId, TaskId, WatchCall } from "@earendil-works/pi-durable";
import { appendedEntries, foldDurableView, initialDurableProjection, runEnded, submissionOutcome } from "../../packages/oar/src/runtimes/pi-durable/projection.js";

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
  expect(foldDurableView(next.state, call(later)).frame.events).toEqual([]);
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
  expect(result.frame.native).toEqual({ ops: correction.ops, retired: false });
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

test("native operations retain unknown documents without storing every complete view", () => {
  const native: Extract<WatchCall<ConversationView>, { kind: "value" }> = {
    ...call({ ...empty, docs: { ...empty.docs, future: { untouched: true } } }),
    ops: [["s", ["docs", "future"], { untouched: true }]],
  };
  const next = foldDurableView(initialDurableProjection(empty), native);
  expect(next.frame.native).toEqual({ ops: native.ops, retired: false });
  expect(next.frame.native).not.toHaveProperty("value");
  const serialized = JSON.stringify(next.frame.native);
  const persisted: unknown = JSON.parse(serialized);
  expect(persisted).toEqual({ ops: native.ops, retired: false });
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

test("a removed running slot ends without inventing a result; a done slot does not end twice", () => {
  const first = view({ tools: [{ callId: "running", name: "tool", status: "running" }, { callId: "done", name: "tool", status: "done" }] });
  const initial = initialDurableProjection(first);
  const next = foldDurableView(initial, call(empty));
  expect(next.frame.events.filter(event => event.kind === "tool_call_ended")).toEqual([{ kind: "tool_call_ended", callId: "running" }]);
});

test("a removed pending slot preserves its native aborted result without inventing a start", () => {
  const first = view({ tools: [{ callId: "pending", name: "tool", status: "pending" }] });
  const entryId = 5;
  assert.ok(isEntryId(entryId));
  const done: ConversationView = { ...empty, entries: [{ id: entryId, conversationId: id, kind: "pi.tool", model: [
    { role: "toolResult", toolCallId: "pending", toolName: "tool", content: [{ type: "text", text: "Tool tool was aborted" }], isError: true, timestamp: 1 },
  ] }] };
  const result = foldDurableView(initialDurableProjection(first), call(done));
  expect(result.frame.events.filter(event => event.kind.startsWith("tool_call_"))).toEqual([
    { kind: "tool_call_ended", callId: "pending", content: [{ type: "text", text: "Tool tool was aborted" }], result: "failed" },
  ]);
});

// oxlint-disable-next-line max-statements -- Compare identical task handover and distinct run identity across two delta shapes.
test("whole-document replacement distinguishes a new run from a generation handover", () => {
  const a = 10; const b = 20; const inputA = 30; const inputB = 40; const firstA = 50; const firstB = 60;
  assert.ok(isTaskId(a) && isTaskId(b) && isSubmissionId(inputA) && isSubmissionId(inputB) && isEntryId(firstA) && isEntryId(firstB));
  const first = view({ run: { taskId: a, inputs: [inputA], first: firstA, turns: 0 } });
  const previous = initialDurableProjection(first);
  const handover = view({ run: { taskId: b, inputs: [inputA], first: firstA, turns: 1 } });
  const next = view({ run: { taskId: b, inputs: [inputB], first: firstB, turns: 0 } });
  expect(runEnded(previous, { ...call(handover), ops: [["s", ["docs", "pi.live"], handover.docs["pi.live"] ?? {}]] })).toBe(false);
  expect(runEnded(previous, { ...call(next), ops: [["s", ["docs", "pi.live"], next.docs["pi.live"] ?? {}]] })).toBe(true);
  expect(runEnded(previous, { ...call(next), ops: [["r", copyJson(next)]], retired: true })).toBe(true);
});
