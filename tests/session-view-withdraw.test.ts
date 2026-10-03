import { expect, test } from "vitest";
import type { Frame, RawEvent, RequestRecord, ResponseRecord, RuntimeEventBody } from "../packages/oar/src/index.js";
import { viewOf, type SessionView } from "../packages/oar/src/observe/session-view.js";

/**
 * A withdrawn input in the session view (docs/design/chat-ui.md): it leaves
 * `pendingInputs`, and `messages` too where the stream placed it at its
 * request; the segment its request sealed stays sealed.
 */

const env = { sessionId: "s1", agentPath: [], receivedAt: 1 };

function request(seq: number, id: string, kind: "prompt" | "queue"): RequestRecord {
  return { ...env, seq, kind: "request", id, direction: "toRuntime", body: { kind, input: `input ${id}`, inputId: `input-${id}` } };
}
/** Queue input `of` again under its own inputId, as an edit after a withdraw does. */
function requeue(seq: number, id: string, of: string): RequestRecord {
  return { ...env, seq, kind: "request", id, direction: "toRuntime", body: { kind: "queue", input: `input ${of}`, inputId: `input-${of}` } };
}
function withdraw(seq: number, id: string, input: string): RequestRecord {
  return { ...env, seq, kind: "request", id, direction: "toRuntime", body: { kind: "withdraw", inputId: `input-${input}` } };
}
function accepted(seq: number, requestId: string): ResponseRecord {
  return { ...env, seq, kind: "response", requestId, body: { kind: "accepted" } };
}
function notQueued(seq: number, requestId: string): ResponseRecord {
  return { ...env, seq, kind: "response", requestId, body: { kind: "rejected", code: "not_queued", reason: "no held input with this inputId is waiting" } };
}
function frame(seq: number, events: RuntimeEventBody[]): Frame {
  return { ...env, seq, kind: "frame", body: { type: "native", native: {}, events } };
}
function text(seq: number, value: string): Frame {
  return frame(seq, [{ kind: "text_delta", text: value }]);
}
function echo(seq: number, id: string): Frame {
  return frame(seq, [{ kind: "user_message", input: `input ${id}`, inputId: `input-${id}`, nativeMessageId: `native-${id}`, evidence: "turn_item" }]);
}
function ended(seq: number): Frame {
  return frame(seq, [{ kind: "turn_ended", outcome: { kind: "completed" } }]);
}
/** One line per message (an open segment is marked), then the pending tray. */
function outline(view: SessionView): string[] {
  const lines = view.messages.map((message, index) => {
    switch (message.kind) {
      case "input":
        return `input ${message.input.input} (${message.input.state})`;
      case "turn": {
        const parts = message.sections.flatMap((section) => section.parts.map((part) => (part.kind === "text" ? part.text : part.kind)));
        return `turn [${parts.join(" | ")}]${message.outcome === undefined ? "" : ` ${message.outcome.kind}`}${index === view.openTurn ? " open" : ""}`;
      }
      case "notice":
        return `notice ${message.notice.cause}`;
    }
    return "?";
  });
  return [...lines, `pending [${view.pendingInputs.map((input) => `${input.input} (${input.state})`).join(", ")}]`];
}

// codex and claude echo input ids: a queued input waits in the tray until the runtime takes it.
const echoing: RawEvent[] = [request(0, "r1", "prompt"), accepted(1, "r1"), echo(2, "r1"), text(3, "working"), request(4, "q1", "queue"), accepted(5, "q1")];

test("on an echoing stream a withdrawn input leaves pendingInputs and nothing else moves", () => {
  expect(outline(viewOf(echoing))).toEqual(["input input r1 (accepted)", "turn [working] open", "pending [input q1 (accepted)]"]);
  const view = viewOf([...echoing, withdraw(6, "w1", "q1"), accepted(7, "w1"), text(8, " more"), ended(9)]);
  expect(outline(view)).toEqual(["input input r1 (accepted)", "turn [working more] completed", "pending []"]);
  expect([...view.conversation.inputs.values()].map((input) => input.state)).toEqual(["accepted", "withdrawn"]);
});

test("a withdraw refused not_queued leaves the input where it was, with no notice", () => {
  const view = viewOf([...echoing, withdraw(6, "w1", "q1"), notQueued(7, "w1")]);
  expect(outline(view)).toEqual(["input input r1 (accepted)", "turn [working] open", "pending [input q1 (accepted)]"]);
});

test("re-queued after a withdraw, the input waits in the tray again", () => {
  const view = viewOf([...echoing, withdraw(6, "w1", "q1"), accepted(7, "w1"), requeue(8, "q2", "q1"), accepted(9, "q2")]);
  expect(outline(view)).toEqual(["input input r1 (accepted)", "turn [working] open", "pending [input q1 (accepted)]"]);
});

// pi, grok and kimi never echo an input id: a queued input enters `messages` at its request.
const silent: RawEvent[] = [request(0, "r1", "prompt"), accepted(1, "r1"), text(2, "working"), request(3, "q1", "queue"), accepted(4, "q1")];

test("on a stream that never echoed, a withdrawn input leaves messages and the segment it sealed stays sealed", () => {
  const placed = viewOf([...silent, text(5, "more")]);
  expect(outline(placed)).toEqual([
    "input input r1 (accepted)",
    "turn [working]",
    "input input q1 (accepted)",
    "turn [more] open",
    "pending []",
  ]);
  const view = viewOf([...silent, text(5, "more"), withdraw(6, "w1", "q1"), accepted(7, "w1"), text(8, " and done"), ended(9)]);
  expect(outline(view)).toEqual(["input input r1 (accepted)", "turn [working]", "turn [more and done] completed", "pending []"]);
});

test("withdrawn right after its request, the input leaves without reopening the segment it sealed", () => {
  const view = viewOf([...silent, withdraw(5, "w1", "q1"), accepted(6, "w1")]);
  expect(outline(view)).toEqual(["input input r1 (accepted)", "turn [working]", "pending []"]);
  expect(view.openTurn).toBe(-1);
  const continued = viewOf([...silent, withdraw(5, "w1", "q1"), accepted(6, "w1"), text(7, "more"), ended(8)]);
  expect(outline(continued)).toEqual(["input input r1 (accepted)", "turn [working]", "turn [more] completed", "pending []"]);
});

test("a withdraw of an input the view never held leaves the transcript alone; a refusal is a notice", () => {
  const view = viewOf([...silent, withdraw(5, "w1", "never"), notQueued(6, "w1")]);
  expect(outline(view)).toEqual(["input input r1 (accepted)", "turn [working]", "input input q1 (accepted)", "notice control_rejected", "pending []"]);
});
