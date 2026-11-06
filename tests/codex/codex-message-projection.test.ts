import { expect, test } from "vitest";
import type { RuntimeEventBody } from "../../packages/oar/src/contracts/session.js";
import { foldCodexNotification, initialCodexProjection, type CodexProjectionState } from "../../packages/oar/src/runtimes/codex/projection.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";

const ROOT = "root";
const TURN = "turn";
const ID = "message";

function apply(state: CodexProjectionState, method: string, params: JsonRecord): { state: CodexProjectionState; events: readonly RuntimeEventBody[] } {
  const next = foldCodexNotification(state, method, params);
  return { state: next.state, events: next.commands.flatMap(command => command.kind === "frame" ? command.body.events : []) };
}
const item = (extra: JsonRecord = {}, threadId = ROOT, turnId = TURN): JsonRecord => ({ threadId, turnId, item: { type: "agentMessage", id: ID, text: "", ...extra } });
const delta = (text: string, threadId = ROOT, turnId = TURN): JsonRecord => ({ threadId, turnId, itemId: ID, delta: text });
const ended = (threadId = ROOT, turnId = TURN): JsonRecord => ({ threadId, turn: { id: turnId, status: "completed" } });

test.each([false, true])("a completed-only message supplies its text once (start observed: %s)", started => {
  const initial = initialCodexProjection(ROOT);
  const before = started ? apply(initial, "item/started", item({ phase: "commentary" })).state : initial;
  const complete = apply(before, "item/completed", item({ text: "answer", phase: "final_answer" }));
  expect(complete.events).toEqual([{ kind: "text_delta", text: "answer", messageId: ID, phase: "final_answer" }]);
  expect(apply(complete.state, "item/completed", item({ text: "answer", phase: "final_answer" })).events).toEqual([]);
  expect(initial.messages.size).toBe(0);
});

test.each(["commentary", "partial_answer", "final_answer", "future-native-phase"])("deltas retain the same item's reported phase %s", phase => {
  const start = apply(initialCodexProjection(ROOT), "item/started", item({ phase }));
  expect(start.events).toEqual([]);
  const first = apply(start.state, "item/agentMessage/delta", delta("hel"));
  const second = apply(first.state, "item/agentMessage/delta", delta("lo"));
  expect([...first.events, ...second.events]).toEqual([
    { kind: "text_delta", text: "hel", messageId: ID, phase },
    { kind: "text_delta", text: "lo", messageId: ID, phase },
  ]);
  expect(apply(second.state, "item/completed", item({ text: "hello", phase })).events).toEqual([]);
});

test("a partial delta prevents appending the full completion or guessing a missing suffix", () => {
  const streamed = apply(initialCodexProjection(ROOT), "item/agentMessage/delta", delta("hel"));
  expect(apply(streamed.state, "item/completed", item({ text: "hello", phase: "final_answer" })).events).toEqual([]);
  expect(streamed.events).toEqual([{ kind: "text_delta", text: "hel", messageId: ID }]);
});

test("an empty delta does not lose the nonempty completed text", () => {
  const empty = apply(initialCodexProjection(ROOT), "item/agentMessage/delta", delta(""));
  expect(apply(empty.state, "item/completed", item({ text: "answer" })).events).toEqual([{ kind: "text_delta", text: "answer", messageId: ID }]);
});

test.each([null, 3, undefined])("missing or malformed phase %s remains absent", phase => {
  const start = apply(initialCodexProjection(ROOT), "item/started", item(phase === undefined ? {} : { phase }));
  expect(apply(start.state, "item/agentMessage/delta", delta("final answer: hello")).events).toEqual([{ kind: "text_delta", text: "final answer: hello", messageId: ID }]);
  expect(apply(start.state, "item/completed", item({ text: "final answer: hello" })).events).toEqual([{ kind: "text_delta", text: "final answer: hello", messageId: ID }]);
});

test("native text evidence belongs to its thread, turn and item; ending one turn leaves the others", () => {
  const root = apply(initialCodexProjection(ROOT), "item/started", item({ phase: "commentary" }));
  const child = apply(root.state, "item/started", item({ phase: "final_answer" }, "child"));
  const otherTurn = apply(child.state, "item/started", item({ phase: "partial_answer" }, ROOT, "other-turn"));
  const streamed = apply(otherTurn.state, "item/agentMessage/delta", delta("root text"));
  const childEnd = apply(streamed.state, "item/completed", item({ text: "child text", phase: "final_answer" }, "child"));
  expect(childEnd.events).toEqual([{ kind: "text_delta", text: "child text", messageId: ID, phase: "final_answer" }]);
  const rootEnd = apply(childEnd.state, "turn/completed", ended());
  expect([rootEnd.state.messages.size, streamed.state.messages.size]).toEqual([2, 3]);
  expect(apply(rootEnd.state, "item/agentMessage/delta", delta("other turn", ROOT, "other-turn")).events).toEqual([{ kind: "text_delta", text: "other turn", messageId: ID, phase: "partial_answer" }]);

});

test("a later item never borrows a previous message's phase or streamed flag", () => {
  const first = apply(initialCodexProjection(ROOT), "item/agentMessage/delta", delta("old"));
  const other = apply(first.state, "item/completed", { threadId: ROOT, turnId: TURN, item: { type: "agentMessage", id: "next", text: "new" } });
  expect(other.events).toEqual([{ kind: "text_delta", text: "new", messageId: "next" }]);
});

test("turn completion releases evidence without mutating the preceding state, including old unscoped messages", () => {
  const first = apply(initialCodexProjection(ROOT), "item/started", { threadId: ROOT, item: { type: "agentMessage", id: ID, phase: "commentary" } }).state;
  const child = apply(first, "item/started", item({ phase: "final_answer" }, "child")).state;
  const rootEnd = apply(child, "turn/completed", ended()).state;
  const childEnd = apply(rootEnd, "turn/completed", ended("child")).state;
  expect([first.messages.size, child.messages.size, rootEnd.messages.size, childEnd.messages.size]).toEqual([1, 2, 1, 0]);
  expect(apply(childEnd, "item/agentMessage/delta", delta("new turn")).events).toEqual([{ kind: "text_delta", text: "new turn", messageId: ID }]);
});

test("non-message completions and empty message completions do not invent text", () => {
  const state = initialCodexProjection(ROOT);
  expect(apply(state, "item/completed", item({ text: "" })).events).toEqual([]);
  const other = apply(state, "item/completed", { item: { type: "unknown", id: ID, text: "not agent text" } });
  expect(other.events).toEqual([]);
  expect(other.state.messages).toBe(state.messages);
});

test("the declared unauthorized turn error is auth without inferred status or credential", () => {
  // Serialized shape from Codex 0.167.0's generated TurnError/CodexErrorInfo.
  // Provider HTTP 401 tests exercise a different native transport variant.
  const params = asRecord(parseJson('{"threadId":"root","turn":{"id":"turn","status":"failed","error":{"message":"not authorized","codexErrorInfo":"unauthorized","additionalDetails":null,"misalignment":null}}}')) ?? {};
  const result = apply(initialCodexProjection(ROOT), "turn/completed", params);
  expect(result.events).toEqual([{ kind: "turn_ended", outcome: { kind: "failed", failure: "auth", reason: "failed" } }]);
});
