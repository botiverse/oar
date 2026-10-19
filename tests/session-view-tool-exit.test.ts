import { expect, test } from "vitest";
import type { Frame, RawEvent, RequestRecord, ResponseRecord, RuntimeEventBody } from "../packages/oar/src/index.js";
import { initialSessionView, reduceSessionView, type SessionView, type ViewTurn } from "../packages/oar/src/observe/session-view.js";

const env: { readonly sessionId: string; readonly agentPath: readonly string[] } = { sessionId: "s1", agentPath: [] };

function request(seq: number, id: string): RequestRecord {
  return { ...env, receivedAt: 1, seq, kind: "request", id, direction: "toRuntime", body: { kind: "prompt", input: `input ${id}`, inputId: `input-${id}` } };
}
function accepted(seq: number, requestId: string): ResponseRecord {
  return { ...env, receivedAt: 1, seq, kind: "response", requestId, body: { kind: "accepted" } };
}
function received(receivedAt: number, seq: number, events: RuntimeEventBody[]): Frame {
  return { ...env, receivedAt, seq, kind: "frame", body: { type: "native", native: {}, events } };
}
function fold(records: readonly RawEvent[]): SessionView {
  return records.reduce((state, record) => reduceSessionView(state, record), initialSessionView());
}
function turns(view: SessionView): ViewTurn[] {
  return view.messages.filter((message): message is ViewTurn => message.kind === "turn");
}

test("a tool part carries the exit status the runtime reported, verbatim, and only then", () => {
  const view = fold([
    request(0, "r1"),
    accepted(1, "r1"),
    received(10, 2, [{ kind: "tool_call_started", callId: "c1", tool: "bash" }]),
    received(20, 3, [{ kind: "tool_call_ended", callId: "c1", result: "ok", exitCode: 3 }]),
    received(30, 4, [{ kind: "tool_call_started", callId: "c2", tool: "bash" }]),
    received(40, 5, [{ kind: "tool_call_ended", callId: "c2", exitCode: null }]),
    received(50, 6, [{ kind: "tool_call_started", callId: "c3", tool: "Bash" }]),
    received(60, 7, [{ kind: "tool_call_ended", callId: "c3", result: "failed" }]),
    // An end without a start (mid-turn subscriber) keeps its exit status too.
    received(70, 8, [{ kind: "tool_call_ended", callId: "c4", exitCode: 143 }]),
  ]);
  const parts = turns(view)[0]?.sections.flatMap((section) => section.parts) ?? [];
  expect(parts).toEqual([
    // A non-zero exit leaves the runtime's own result alone.
    { kind: "tool", callId: "c1", tool: "bash", result: "ok", exitCode: 3, startedAt: 10, endedAt: 20 },
    { kind: "tool", callId: "c2", tool: "bash", result: "ended", exitCode: null, startedAt: 30, endedAt: 40 },
    // No exit status reported: none derived from the failed result.
    { kind: "tool", callId: "c3", tool: "Bash", result: "failed", startedAt: 50, endedAt: 60 },
    { kind: "tool", callId: "c4", tool: "?", result: "ended", exitCode: 143, endedAt: 70 },
  ]);
});
