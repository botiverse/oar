import { expect, test } from "vitest";
import type { Event, RawEvent, RequestRecord, ResponseRecord } from "../packages/oar/src/index.js";
import { controlActionsOf, eventsOf, eventsReader } from "../packages/oar/src/observe/events.js";
import { conversationOf, reduceConversation, type ConversationInput } from "../packages/oar/src/observe/conversation.js";
import { withdrawHeld } from "../packages/oar/src/kernel.js";

/**
 * `withdraw` in the record stream (docs/spec/record-stream.md): a toRuntime
 * request naming the held input, answered accepted (taken back) or rejected
 * `not_queued`. The queue request and its response are never touched; the
 * reading is the events and the conversation fold.
 */

const inputId = "11111111-2222-4333-8444-555555555555";
const env = { sessionId: "s", agentPath: [], receivedAt: 0 };

function queue(seq: number, id: string): RequestRecord {
  return { ...env, seq, kind: "request", id, direction: "toRuntime", body: { kind: "queue", input: "later", inputId } };
}
function withdraw(seq: number, id: string, target = inputId): RequestRecord {
  return { ...env, seq, kind: "request", id, direction: "toRuntime", body: { kind: "withdraw", inputId: target } };
}
function accepted(seq: number, requestId: string): ResponseRecord {
  return { ...env, seq, kind: "response", requestId, body: { kind: "accepted" } };
}
function notQueued(seq: number, requestId: string): ResponseRecord {
  return { ...env, seq, kind: "response", requestId, body: { kind: "rejected", code: "not_queued", reason: "no held input with this inputId is waiting" } };
}
function readAll(records: readonly RawEvent[]): Event[] {
  const events: Event[] = [];
  const read = eventsReader((event) => {
    events.push(event);
  });
  for (const record of records) {
    read(record);
  }
  return events;
}
function onlyInput(records: readonly RawEvent[]): ConversationInput | undefined {
  const inputs = [...conversationOf(records).inputs.values()];
  expect(inputs).toHaveLength(1);
  return inputs[0];
}

test("an accepted withdraw reads as input_withdrawn; a refused one as control_rejected with action withdraw", () => {
  const records = [queue(0, "q"), accepted(1, "q"), withdraw(2, "w1"), accepted(3, "w1"), withdraw(4, "w2"), notQueued(5, "w2")];
  const expected = [
    { kind: "input_withdrawn", requestId: "w1", inputId, seq: 3 },
    { kind: "control_rejected", requestId: "w2", action: "withdraw", code: "not_queued", seq: 5 },
  ];
  expect(readAll(records)).toMatchObject(expected);
  // A retained log replays into the same events.
  const actions = controlActionsOf(records);
  expect(records.flatMap((record) => eventsOf(record, actions))).toMatchObject(expected);
  // Without the request, the response alone names no input: nothing is guessed.
  expect(eventsOf(accepted(3, "w1"))).toEqual([]);
});

test("an accepted withdraw makes the input withdrawn and leaves its queue attempt as it was", () => {
  const input = onlyInput([queue(0, "q"), accepted(1, "q"), withdraw(2, "w"), accepted(3, "w")]);
  expect(input).toMatchObject({ state: "withdrawn", input: "later", inputId });
  expect(input?.attempts.map((attempt) => [attempt.request.body.kind, attempt.state])).toEqual([["queue", "accepted"], ["withdraw", "accepted"]]);
});

test("a withdraw still unanswered or refused not_queued changes nothing", () => {
  expect(onlyInput([queue(0, "q"), accepted(1, "q"), withdraw(2, "w")])?.state).toBe("accepted");
  expect(onlyInput([queue(0, "q"), accepted(1, "q"), withdraw(2, "w"), notQueued(3, "w")])?.state).toBe("accepted");
});

test("a re-queue of a withdrawn input is pending, then accepted, by the ordinary rules", () => {
  const withdrawn = [queue(0, "q1"), accepted(1, "q1"), withdraw(2, "w"), accepted(3, "w")];
  expect(onlyInput([...withdrawn, queue(4, "q2")])?.state).toBe("pending");
  expect(onlyInput([...withdrawn, queue(4, "q2"), accepted(5, "q2")])?.state).toBe("accepted");
  // Withdrawn again after the re-queue: only what follows the latest withdraw counts.
  expect(onlyInput([...withdrawn, queue(4, "q2"), accepted(5, "q2"), withdraw(6, "w2"), accepted(7, "w2")])?.state).toBe("withdrawn");
});

test("a withdraw of an input the conversation never saw makes no bubble; its answer stays an event", () => {
  const unknown = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const state = conversationOf([withdraw(0, "w", unknown)]);
  expect(state.inputs.size).toBe(0);
  const answered = reduceConversation(state, notQueued(1, "w"));
  expect(answered.updates).toMatchObject([{ kind: "event", event: { kind: "control_rejected", action: "withdraw", code: "not_queued" } }]);
  expect(reduceConversation(state, accepted(1, "w")).updates).toMatchObject([{ kind: "event", event: { kind: "input_withdrawn", inputId: unknown } }]);
});

test("withdrawHeld removes every entry held for the input, or answers not_queued", () => {
  const held = [{ inputId: "a" }, { inputId: undefined }, { inputId: "b" }, { inputId: "a" }];
  expect(withdrawHeld(held, "a")).toEqual({ kind: "accepted" });
  expect(held).toEqual([{ inputId: undefined }, { inputId: "b" }]);
  expect(withdrawHeld(held, "a")).toEqual({ kind: "rejected", code: "not_queued", reason: "no held input with this inputId is waiting" });
  expect(held).toHaveLength(2);
});
