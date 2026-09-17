import { expect, test } from "vitest";
import type { RawEvent, RequestRecord, ResponseRecord, Frame } from "../packages/oar/src/index.js";
import { conversationOf, initialConversation, reduceConversation, observeConversation, type ConversationState } from "../packages/oar/src/observe/conversation.js";
import { startMockSession } from "../sea-trial/fixtures/mock-session.js";

const inputId = "11111111-2222-4333-8444-555555555555";
const envelope = { sessionId: "native", agentPath: [], receivedAt: 1 };
function request(seq: number, id: string, options: { action?: "prompt" | "steer" | "queue"; inputId?: string } = {}): RequestRecord {
  return { ...envelope, seq, kind: "request", id, direction: "toRuntime", body: { kind: options.action ?? "steer", input: "same text", inputId: options.inputId ?? inputId } };
}
function response(seq: number, requestId: string, accepted = true): ResponseRecord {
  return { ...envelope, seq, kind: "response", requestId, body: accepted ? { kind: "accepted" } : { kind: "rejected", reason: "not_steerable" } };
}
function echo(seq: number): Frame {
  return { ...envelope, seq, kind: "frame", body: { type: "native-user", native: {}, events: [{ kind: "user_message", inputId, input: "same text", nativeMessageId: "native-message", evidence: "turn_item", turnId: "turn-1" }] } };
}

test("input appears before response; fallback and native echo update one input", () => {
  const first = reduceConversation(initialConversation(), request(0, "r1"));
  expect(first.updates).toMatchObject([{ kind: "input", input: { state: "pending", input: "same text" } }]);
  const state = [response(1, "r1", false), request(2, "r2", { action: "queue" }), response(3, "r2"), echo(4)].reduce((current, record) => reduceConversation(current, record), first);
  expect(state.inputs.size).toBe(1);
  expect([...state.inputs.values()][0]).toMatchObject({ state: "accepted", attempts: [{ state: "rejected" }, { state: "accepted" }], observations: [{ evidence: "turn_item", turnId: "turn-1" }] });
  expect(state.updates).toHaveLength(1);
});

test("echo before acknowledgement remains independent evidence, not acceptance", () => {
  const state = conversationOf([request(0, "r"), echo(1)]);
  expect([...state.inputs.values()][0]).toMatchObject({ state: "pending", observations: [{ nativeMessageId: "native-message" }] });
  expect([...reduceConversation(state, response(2, "r")).inputs.values()][0]?.state).toBe("accepted");
});

test("identical text and child requests do not alias", () => {
  const other = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const state = conversationOf([request(0, "r"), request(1, "r2", { inputId: other }), { ...request(2, "r"), agentPath: ["child"] }, response(3, "r")]);
  expect([...state.inputs.values()].map((input) => input.state)).toEqual(["accepted", "pending", "pending"]);
});

test("resume restarts seq, operation IDs are stream-scoped, native echo is deduplicated", () => {
  let state = conversationOf([request(0, "r"), response(1, "r"), echo(2)]);
  expect(reduceConversation(state, echo(2)).updates).toEqual([]);
  state = reduceConversation(state, echo(0), "resumed");
  expect(state.updates).toEqual([]);
  state = reduceConversation(state, request(1, "r", { inputId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }), "resumed");
  state = reduceConversation(state, response(2, "r", false), "resumed");
  expect([...state.inputs.values()].map((input) => input.state)).toEqual(["accepted", "rejected"]);
});

test("unlinked native messages and turn completion never guess consumption", () => {
  const unlinked: RawEvent = { ...echo(2), body: { type: "message_start", native: {}, events: [{ kind: "user_message", evidence: "conversation", input: "same text" }] } };
  let state = conversationOf([request(0, "r"), response(1, "r"), unlinked]);
  expect(state.updates).toMatchObject([{ kind: "event", event: { kind: "user_message" } }]);
  state = reduceConversation(state, { ...echo(3), body: { type: "done", native: {}, events: [{ kind: "turn_ended", outcome: { kind: "completed" } }] } });
  expect([...state.inputs.values()][0]).toMatchObject({ state: "accepted", observations: [] });
});

test("steerOrQueue preserves generated identity across both attempts", async () => {
  const session = await startMockSession({ kind: "available", via: "bundled" }, { cwd: "/tmp" });
  try {
    const result = await session.steerOrQueue("later");
    expect(result.landed).toBe("queued");
    const attempts = session.records().filter((record): record is RequestRecord => record.kind === "request" && "input" in record.body);
    expect(attempts).toHaveLength(2);
    expect(typeof (attempts[0]?.body.kind === "steer" ? attempts[0].body.inputId : undefined)).toBe("string");
    expect(attempts[1]?.body).toMatchObject({ inputId: attempts[0]?.body.kind === "steer" ? attempts[0].body.inputId : null });
    expect(attempts[0]?.id).not.toBe(attempts[1]?.id);
  } finally { await session.dispose(); }
});

test("live observer folds the prefix even when callbacks start after a cursor", async () => {
  const session = await startMockSession({ kind: "available", via: "bundled" }, { cwd: "/tmp" });
  try {
    await session.steer("before");
    const views: ConversationState[] = [];
    const off = observeConversation(session, (state) => { views.push(state); }, { sessionId: session.id, afterSeq: session.records().at(-1)?.seq ?? -1 });
    expect(views).toEqual([]);
    await session.queue("after");
    expect({ inputs: views.at(-1)?.inputs, size: views.at(-1)?.inputs.size }).toEqual({ inputs: conversationOf(session.records()).inputs, size: 2 });
    off();
  } finally { await session.dispose(); }
});
