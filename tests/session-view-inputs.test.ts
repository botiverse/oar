import { expect, test } from "vitest";
import type { Frame, RawEvent, RequestRecord, ResponseRecord, RuntimeEventBody } from "../packages/oar/src/index.js";
import {
  initialSessionView,
  reduceSessionView,
  viewOf,
  type SessionView,
  type ViewTurn,
} from "../packages/oar/src/observe/session-view.js";

/**
 * Where an input enters the session view (#82): a steer or queue at its
 * first native echo on a stream that echoes input ids, waiting in
 * `pendingInputs` until then; at its request on a stream that never echoed
 * one. The real codex run is pinned in tests/replay/codex-steer-order.test.ts.
 */

const env: { readonly sessionId: string; readonly agentPath: readonly string[]; readonly receivedAt: number } =
  { sessionId: "s1", agentPath: [], receivedAt: 1 };

function request(seq: number, id: string, kind: "prompt" | "steer" | "queue" = "prompt"): RequestRecord {
  return { ...env, seq, kind: "request", id, direction: "toRuntime", body: { kind, input: `input ${id}`, inputId: `input-${id}` } };
}
/** Another attempt at input `of` (same inputId), as `deliver` and `steerOrQueue` retry. */
function retry(seq: number, id: string, of: { readonly kind: "steer" | "queue"; readonly input: string }): RequestRecord {
  return { ...env, seq, kind: "request", id, direction: "toRuntime", body: { kind: of.kind, input: `input ${of.input}`, inputId: `input-${of.input}` } };
}
function accepted(seq: number, requestId: string): ResponseRecord {
  return { ...env, seq, kind: "response", requestId, body: { kind: "accepted" } };
}
function rejected(seq: number, requestId: string): ResponseRecord {
  return { ...env, seq, kind: "response", requestId, body: { kind: "rejected", code: "busy", reason: "busy" } };
}
function frame(seq: number, events: RuntimeEventBody[]): Frame {
  return { ...env, seq, kind: "frame", body: { type: "native", native: {}, events } };
}
function text(seq: number, value: string): Frame {
  return frame(seq, [{ kind: "text_delta", text: value }]);
}
function fold(records: readonly RawEvent[]): SessionView {
  return records.reduce((state, record) => reduceSessionView(state, record), initialSessionView());
}
function turns(view: SessionView): ViewTurn[] {
  return view.messages.filter((message): message is ViewTurn => message.kind === "turn");
}

/** A native echo of input `id` (codex `userMessage` item, claude replay). */
function echo(seq: number, id: string): Frame {
  return frame(seq, [{ kind: "user_message", input: `input ${id}`, inputId: `input-${id}`, nativeMessageId: `native-${id}`, evidence: "turn_item" }]);
}
function ended(seq: number): Frame {
  return frame(seq, [{ kind: "turn_ended", outcome: { kind: "completed" } }]);
}
/** Inputs by their text and turns by their text parts, one line per message, then the pending tray. */
function outline(view: SessionView): string[] {
  const lines = view.messages.map((message) => {
    switch (message.kind) {
      case "input":
        return `input ${message.input.input} (${message.input.state})`;
      case "turn": {
        const parts = message.sections.flatMap((section) => section.parts.map((part) => (part.kind === "text" ? part.text : part.kind)));
        return `turn [${parts.join(" | ")}]${message.outcome === undefined ? "" : ` ${message.outcome.kind}`}`;
      }
      case "notice":
        return `notice ${message.notice.cause}`;
    }
    return "?";
  });
  return [...lines, `pending [${view.pendingInputs.map((input) => input.input).join(", ")}]`];
}

test("on an echoing stream a steer waits in pendingInputs and enters where the runtime took it", () => {
  const records: RawEvent[] = [
    request(0, "r1"),
    accepted(1, "r1"),
    echo(2, "r1"),
    text(3, "working"),
    request(4, "s1", "steer"),
    accepted(5, "s1"),
    text(6, " still on it"),
  ];
  const before = fold(records);
  expect(outline(before)).toEqual([
    "input input r1 (accepted)",
    "turn [working still on it]",
    "pending [input s1]",
  ]);
  expect(before.openTurn).toBe(1);
  const view = fold([...records, echo(7, "s1"), text(8, "got s1"), ended(9)]);
  expect(outline(view)).toEqual([
    "input input r1 (accepted)",
    "turn [working still on it]",
    "input input s1 (accepted)",
    "turn [got s1] completed",
    "pending []",
  ]);
});

test("on a stream that never echoed an input id, a steer enters at its request", () => {
  // pi echoes without an inputId; grok and kimi do not echo at all.
  const unlinked = frame(2, [{ kind: "user_message", input: "input r1", evidence: "conversation" }]);
  const view = fold([
    request(0, "r1"),
    accepted(1, "r1"),
    unlinked,
    text(3, "before"),
    request(4, "s1", "steer"),
    accepted(5, "s1"),
    text(6, "after"),
    ended(7),
  ]);
  expect(outline(view)).toEqual([
    "input input r1 (accepted)",
    "turn [before]",
    "input input s1 (accepted)",
    "turn [after] completed",
    "pending []",
  ]);
});

test("a steer still unread when its turn ends stays pending; its late echo places it in the later turn", () => {
  const records: RawEvent[] = [
    request(0, "r1"),
    accepted(1, "r1"),
    echo(2, "r1"),
    text(3, "done"),
    request(4, "s1", "steer"),
    accepted(5, "s1"),
    ended(6),
  ];
  const unread = fold(records);
  expect(outline(unread)).toEqual([
    "input input r1 (accepted)",
    "turn [done] completed",
    "pending [input s1]",
  ]);
  expect(unread.messages.some((message) => message.kind === "input" && message.input.input === "input s1")).toBe(false);
  const later = fold([...records, request(7, "r2"), accepted(8, "r2"), echo(9, "r2"), text(10, "on r2"), echo(11, "s1"), text(12, "and s1"), ended(13)]);
  expect(outline(later)).toEqual([
    "input input r1 (accepted)",
    "turn [done] completed",
    "input input r2 (accepted)",
    "turn [on r2]",
    "input input s1 (accepted)",
    "turn [and s1] completed",
    "pending []",
  ]);
});

test("a queued input waits for the turn that takes it; its echo comes before that turn's content", () => {
  const view = fold([
    request(0, "r1"),
    accepted(1, "r1"),
    echo(2, "r1"),
    text(3, "first"),
    request(4, "q1", "queue"),
    accepted(5, "q1"),
    text(6, " still first"),
    ended(7),
    // The runtime drains its queue into a turn of its own: no prompt request.
    echo(8, "q1"),
    text(9, "on q1"),
    ended(10),
  ]);
  expect(outline(view)).toEqual([
    "input input r1 (accepted)",
    "turn [first still first] completed",
    "input input q1 (accepted)",
    "turn [on q1] completed",
    "pending []",
  ]);
  expect(turns(view)[1]?.openedBy).toBeUndefined();
});

test("a refused steer enters where it was refused; a queue retry of it waits for its echo, and the turn it split rejoins", () => {
  const records: RawEvent[] = [
    request(0, "r1"),
    accepted(1, "r1"),
    echo(2, "r1"),
    text(3, "working"),
    request(4, "s1", "steer"),
    rejected(5, "s1"),
  ];
  expect(outline(fold(records))).toEqual([
    "input input r1 (accepted)",
    "turn [working]",
    "input input s1 (rejected)",
    "pending []",
  ]);
  // steerOrQueue: the same input id, now queued.
  const view = fold([...records, retry(6, "q1", { kind: "queue", input: "s1" }), accepted(7, "q1"), text(8, " more"), ended(9)]);
  expect(outline(view)).toEqual([
    "input input r1 (accepted)",
    "turn [working more] completed",
    "pending [input s1]",
  ]);
});

test("a prompt refused busy and retried as a steer waits for its echo (deliver's race)", () => {
  const view = fold([
    request(0, "r1"),
    accepted(1, "r1"),
    echo(2, "r1"),
    text(3, "working"),
    request(4, "r2"),
    rejected(5, "r2"),
    retry(6, "s2", { kind: "steer", input: "r2" }),
    accepted(7, "s2"),
    text(8, " more"),
    echo(9, "r2"),
    text(10, "got r2"),
  ]);
  expect(outline(view)).toEqual([
    "input input r1 (accepted)",
    "turn [working more]",
    "input input r2 (accepted)",
    "turn [got r2]",
    "pending []",
  ]);
});

test("a steer pending in one stream enters at its echo in the next (resume restarts seq)", () => {
  const exit: ResponseRecord = { ...env, seq: 6, kind: "response", requestId: "", body: { kind: "exited", code: null } };
  let view = initialSessionView();
  for (const record of [request(0, "r1"), accepted(1, "r1"), echo(2, "r1"), text(3, "working"), request(4, "s1", "steer"), accepted(5, "s1"), exit]) {
    view = reduceSessionView(view, record, "a");
  }
  expect(view.pendingInputs.map((input) => input.input)).toEqual(["input s1"]);
  for (const record of [echo(0, "s1"), text(1, "resumed on s1"), ended(2)]) {
    view = reduceSessionView(view, record, "b");
  }
  expect(outline(view)).toEqual([
    "input input r1 (accepted)",
    "turn [working]",
    "notice exited",
    "input input s1 (accepted)",
    "turn [resumed on s1] completed",
    "pending []",
  ]);
});

test("records folded twice in one stream change nothing", () => {
  const records: RawEvent[] = [
    request(0, "r1"),
    accepted(1, "r1"),
    echo(2, "r1"),
    text(3, "working"),
    request(4, "s1", "steer"),
    accepted(5, "s1"),
    echo(6, "s1"),
    request(7, "s2", "steer"),
    accepted(8, "s2"),
    ended(9),
  ];
  const once = viewOf(records);
  const twice = viewOf([...records, ...records]);
  expect(twice.messages).toEqual(once.messages);
  expect(twice.pendingInputs).toEqual(once.pendingInputs);
  expect(twice.status).toEqual(once.status);
  expect(outline(once)).toEqual([
    "input input r1 (accepted)",
    "turn [working]",
    "input input s1 (accepted)",
    "turn [] completed",
    "pending [input s2]",
  ]);
});
