import { expect, test } from "vitest";
import type { Frame, RawEvent, RequestRecord, ResponseRecord, RuntimeEventBody } from "../packages/oar/src/index.js";
import {
  initialSessionView,
  reduceSessionView,
  reduceSessionViewEvent,
  viewOf,
  type SessionView,
  type ViewTurn,
} from "../packages/oar/src/observe/session-view.js";

const env: { readonly sessionId: string; readonly agentPath: readonly string[]; readonly receivedAt: number } =
  { sessionId: "s1", agentPath: [], receivedAt: 1 };

function request(seq: number, id: string, kind: "prompt" | "steer" | "queue" = "prompt"): RequestRecord {
  return { ...env, seq, kind: "request", id, direction: "toRuntime", body: { kind, input: `input ${id}`, inputId: `input-${id}` } };
}
function accepted(seq: number, requestId: string): ResponseRecord {
  return { ...env, seq, kind: "response", requestId, body: { kind: "accepted" } };
}
function rejected(seq: number, requestId: string): ResponseRecord {
  return { ...env, seq, kind: "response", requestId, body: { kind: "rejected", code: "busy", reason: "busy" } };
}
function frame(seq: number, events: RuntimeEventBody[], at: { sessionId?: string; agentPath?: readonly string[] } = {}): Frame {
  return {
    ...env,
    ...(at.sessionId === undefined ? {} : { sessionId: at.sessionId }),
    ...(at.agentPath === undefined ? {} : { agentPath: at.agentPath }),
    seq,
    kind: "frame",
    body: { type: "native", native: {}, events },
  };
}
function text(seq: number, value: string, at?: { sessionId?: string; agentPath?: readonly string[] }): Frame {
  return frame(seq, [{ kind: "text_delta", text: value }], at);
}
function fold(records: readonly RawEvent[]): SessionView {
  return records.reduce((state, record) => reduceSessionView(state, record), initialSessionView());
}
function turns(view: SessionView): ViewTurn[] {
  return view.messages.filter((message): message is ViewTurn => message.kind === "turn");
}

test("a prompt turn groups text and tool parts under one lane section", () => {
  const view = fold([
    request(0, "r1"),
    accepted(1, "r1"),
    text(2, "Hello"),
    frame(3, [{ kind: "tool_call_started", callId: "c1", tool: "Read", input: "f.ts" }]),
    frame(4, [{ kind: "tool_call_ended", callId: "c1", content: [{ type: "text", text: "contents" }], result: "ok" }]),
    frame(5, [{ kind: "turn_ended", outcome: { kind: "completed" } }]),
  ]);
  expect(view.messages.map((message) => message.kind)).toEqual(["input", "turn"]);
  const [turn] = turns(view);
  expect(turn?.outcome).toEqual({ kind: "completed" });
  expect(turn?.openedBy).toBe("r1");
  expect(turn?.sections).toHaveLength(1);
  expect(turn?.sections[0]?.parts).toEqual([
    { kind: "text", text: "Hello" },
    { kind: "tool", callId: "c1", tool: "Read", input: "f.ts", content: [{ type: "text", text: "contents" }], result: "ok", startedAt: 1, endedAt: 1 },
  ]);
});

// codex can send a command's last `outputDelta` after `turn/completed` (issue #39).
test("a call's progress after its turn ended settles its own part; no segment, no ? part", () => {
  const view = fold([
    request(0, "r1"),
    accepted(1, "r1"),
    frame(2, [{ kind: "tool_call_started", callId: "c1", tool: "Bash", input: "ls" }]),
    frame(3, [{ kind: "turn_ended", outcome: { kind: "completed" } }]),
    frame(4, [{ kind: "tool_call_progress", callId: "c1", output: "a.ts" }]),
    request(5, "r2"),
    accepted(6, "r2"),
    frame(7, [{ kind: "tool_call_ended", callId: "c1", content: [{ type: "text", text: "a.ts b.ts" }], result: "ok" }]),
    frame(8, [{ kind: "tool_call_progress", callId: "c9", output: "unseen" }]),
  ]);
  expect(view.messages.map((message) => message.kind)).toEqual(["input", "turn", "input", "turn"]);
  const [first, second] = turns(view);
  expect(first?.outcome).toEqual({ kind: "completed" });
  expect(first?.sections.flatMap((section) => section.parts)).toEqual([
    { kind: "tool", callId: "c1", tool: "Bash", input: "ls", content: [{ type: "text", text: "a.ts b.ts" }], result: "ok", startedAt: 1, endedAt: 1 },
  ]);
  expect(second?.sections.flatMap((section) => section.parts)).toEqual([
    { kind: "tool", callId: "c9", tool: "?", output: "unseen", result: "running" },
  ]);
});

test("a rejected prompt removes the empty turn; the input keeps the rejection", () => {
  const view = fold([request(0, "r1"), rejected(1, "r1")]);
  expect(view.messages.map((message) => message.kind)).toEqual(["input"]);
  expect(view.messages[0]).toMatchObject({ kind: "input", input: { state: "rejected" } });
  expect(view.openTurn).toBe(-1);
});

test("a mid-turn input seals the segment; the outcome lands on the last one", () => {
  const view = fold([
    request(0, "r1"),
    accepted(1, "r1"),
    text(2, "before"),
    request(3, "r2", "steer"),
    accepted(4, "r2"),
    text(5, "after"),
    frame(6, [{ kind: "turn_ended", outcome: { kind: "completed" } }]),
  ]);
  expect(view.messages.map((message) => message.kind)).toEqual(["input", "turn", "input", "turn"]);
  const [first, second] = turns(view);
  expect(first?.outcome).toBeUndefined();
  expect(first?.sections[0]?.parts).toEqual([{ kind: "text", text: "before" }]);
  expect(second?.outcome).toEqual({ kind: "completed" });
  expect(second?.sections[0]?.parts).toEqual([{ kind: "text", text: "after" }]);
});

test("sub-agent activity nests as a section; the parent's tool settles in its own lane", () => {
  const view = fold([
    request(0, "r1"),
    accepted(1, "r1"),
    frame(2, [{ kind: "tool_call_started", callId: "c1", tool: "Task" }]),
    text(3, "child says", { agentPath: ["child-1"] }),
    frame(4, [{ kind: "tool_call_ended", callId: "c1", result: "ok" }]),
    frame(5, [{ kind: "turn_ended", outcome: { kind: "completed" } }]),
  ]);
  const [turn] = turns(view);
  expect(turn?.sections).toHaveLength(2);
  expect(turn?.sections[0]?.agentPath).toEqual([]);
  expect(turn?.sections[0]?.parts).toEqual([
    { kind: "tool", callId: "c1", tool: "Task", result: "ok", startedAt: 1, endedAt: 1 },
  ]);
  expect(turn?.sections[1]?.agentPath).toEqual(["child-1"]);
  expect(turn?.sections[1]?.parts).toEqual([{ kind: "text", text: "child says" }]);
});

test("a child session's turn_ended becomes a notice; it never closes the root turn", () => {
  const view = fold([
    request(0, "r1"),
    accepted(1, "r1"),
    text(2, "root working"),
    frame(3, [{ kind: "turn_ended", outcome: { kind: "completed" } }], { sessionId: "child-session" }),
    text(4, "still root"),
    frame(5, [{ kind: "turn_ended", outcome: { kind: "completed" } }]),
  ]);
  expect(turns(view)).toHaveLength(1);
  const [turn] = turns(view);
  expect(turn?.sections).toHaveLength(3);
  expect(turn?.sections[1]?.sessionId).toBe("child-session");
  expect(turn?.sections[1]?.parts).toEqual([
    { kind: "notice", notice: { cause: "child_turn_ended", outcome: { kind: "completed" } } },
  ]);
  expect(turn?.outcome).toEqual({ kind: "completed" });
});

test("events without a prompt open an adopted turn", () => {
  const view = fold([
    text(0, "queued work started"),
    frame(1, [{ kind: "turn_ended", outcome: { kind: "completed" } }]),
  ]);
  const [turn] = turns(view);
  expect(turn?.openedBy).toBeUndefined();
  expect(turn?.outcome).toEqual({ kind: "completed" });
});

test("a runtime request is pending until answered; its part settles in place", () => {
  const ask: RequestRecord = {
    ...env, seq: 2, kind: "request", id: "req9", direction: "toApp",
    body: { kind: "native", type: "approval", native: { command: "rm -rf" } },
  };
  const answer: ResponseRecord = {
    ...env, seq: 3, kind: "response", requestId: "req9", body: { kind: "answered", native: { allow: true } },
  };
  const mid = fold([request(0, "r1"), accepted(1, "r1"), ask]);
  expect(mid.pendingRequests).toEqual([
    { requestId: "req9", type: "approval", sessionId: "s1", agentPath: [], seq: 2, body: { command: "rm -rf" } },
  ]);
  const view = reduceSessionView(mid, answer);
  expect(view.pendingRequests).toEqual([]);
  const [turn] = turns(view);
  expect(turn?.sections[0]?.parts).toEqual([
    { kind: "app_request", requestId: "req9", type: "approval", answered: true },
  ]);
});

test("an exit records the fact and never stamps a fabricated outcome", () => {
  const exit: ResponseRecord = { ...env, seq: 3, kind: "response", requestId: "", body: { kind: "exited", code: 1 } };
  const view = fold([request(0, "r1"), accepted(1, "r1"), text(2, "partial"), exit]);
  expect(view.exited).toEqual({ code: 1 });
  const [turn] = turns(view);
  expect(turn?.outcome).toBeUndefined();
  expect(view.messages.at(-1)).toMatchObject({ kind: "notice", notice: { cause: "exited", code: 1 } });
});

test("model, effort, context and token usage fold into view fields", () => {
  const view = fold([
    request(0, "r1"),
    accepted(1, "r1"),
    frame(2, [
      { kind: "model", model: "test-model" },
      { kind: "effort", effort: "high" },
      { kind: "usage", usage: { context: { tokens: 1000, contextWindow: 2000, percent: 50 }, tokens: { input: 10, output: 5 } } },
    ]),
    frame(3, [{ kind: "usage", usage: { tokens: { input: 3, output: 1 } } }], { agentPath: ["child"] }),
  ]);
  expect(view.model).toBe("test-model");
  expect(view.effort).toBe("high");
  expect(view.context).toEqual({ tokens: 1000, contextWindow: 2000, percent: 50 });
  expect(view.usage).toEqual({
    total: { input: 13, output: 6 },
    byAgent: [
      { agentPath: [], tokens: { input: 10, output: 5 } },
      { agentPath: ["child"], tokens: { input: 3, output: 1 } },
    ],
  });
});

test("replay and incremental folds agree", () => {
  const records: RawEvent[] = [
    request(0, "r1"),
    accepted(1, "r1"),
    text(2, "Hello"),
    frame(3, [{ kind: "reasoning", content: { kind: "text", text: "thinking" } }]),
    frame(4, [{ kind: "turn_ended", outcome: { kind: "completed" } }]),
  ];
  expect(fold(records)).toEqual(viewOf(records));
});

test("the flat-event entry folds display facts without conversation state", () => {
  const events = [
    { ...env, seq: 0, kind: "turn_started", requestId: "r1", input: "go" },
    { ...env, seq: 1, kind: "text_delta", text: "hi" },
    { ...env, seq: 2, kind: "turn_ended", outcome: { kind: "completed" } },
  ] as const;
  const view = events.reduce(
    (state, event) => reduceSessionViewEvent(state, event),
    initialSessionView(),
  );
  const [turn] = turns(view);
  expect(turn?.openedBy).toBe("r1");
  expect(turn?.sections[0]?.parts).toEqual([{ kind: "text", text: "hi" }]);
  expect(turn?.outcome).toEqual({ kind: "completed" });
});

test("a tool part carries the result's ordered parts (#73)", () => {
  const content = [{ type: "text", text: "shot" }, { type: "image", mediaType: "image/png", data: "iVBOR" }] as const;
  const view = fold([
    request(0, "r1"),
    accepted(1, "r1"),
    frame(2, [{ kind: "tool_call_started", callId: "c1", tool: "Read", input: "a.png" }]),
    frame(3, [{ kind: "tool_call_ended", callId: "c1", content, result: "ok" }]),
    frame(4, [{ kind: "tool_call_ended", callId: "c2", content, result: "ok" }]),
  ]);
  const parts = turns(view)[0]?.sections.flatMap((section) => section.parts) ?? [];
  expect(parts).toMatchObject([
    { kind: "tool", callId: "c1", content, result: "ok" },
    { kind: "tool", callId: "c2", tool: "?", content, result: "ok" },
  ]);
});

function received(receivedAt: number, record: Frame): Frame {
  return { ...record, receivedAt };
}

test("a tool part carries when OAR saw its start and end, and only what it saw", () => {
  const view = fold([
    request(0, "r1"),
    accepted(1, "r1"),
    received(1000, frame(2, [{ kind: "tool_call_started", callId: "c1", tool: "sleep", input: '{"durationMs":50000}' }])),
    received(8500, frame(3, [{ kind: "tool_call_ended", callId: "c1" }])),
    received(9000, frame(4, [{ kind: "tool_call_started", callId: "c2", tool: "Bash" }])),
    received(9500, frame(5, [{ kind: "tool_call_ended", callId: "c3", result: "ok" }])),
  ]);
  const parts = turns(view)[0]?.sections.flatMap((section) => section.parts) ?? [];
  expect(parts).toEqual([
    { kind: "tool", callId: "c1", tool: "sleep", input: '{"durationMs":50000}', result: "ended", startedAt: 1000, endedAt: 8500 },
    { kind: "tool", callId: "c2", tool: "Bash", result: "running", startedAt: 9000 },
    { kind: "tool", callId: "c3", tool: "?", result: "ok", endedAt: 9500 },
  ]);
});

test("text with a new messageId starts a new part; text without one joins the last", () => {
  const say = (seq: number, value: string, messageId?: string): Frame =>
    frame(seq, [{ kind: "text_delta", text: value, ...(messageId === undefined ? {} : { messageId }) }]);
  const view = fold([
    request(0, "r1"),
    accepted(1, "r1"),
    say(2, "Got it", "m1"),
    say(3, ".", "m1"),
    say(4, "Waited", "m2"),
    say(5, " 100 s."),
  ]);
  expect(turns(view)[0]?.sections[0]?.parts).toEqual([
    { kind: "text", text: "Got it.", messageId: "m1" },
    { kind: "text", text: "Waited 100 s.", messageId: "m2" },
  ]);
});
