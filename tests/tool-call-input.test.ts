import { expect, test } from "vitest";
import type { Frame, RawEvent, RuntimeEventBody } from "../packages/oar/src/index.js";
import { initialStatus, reduceStatus } from "../packages/oar/src/observe/agent-status.js";
import { viewOf } from "../packages/oar/src/observe/session-view.js";

/**
 * `tool_call_input`: arguments a runtime reports after the call started (an ACP
 * `tool_call_update` with a new `rawInput`; opencode and kimi send theirs only
 * there, issue #147). The consumer folds read it as the call's whole input.
 */

function frame(seq: number, receivedAt: number, events: RuntimeEventBody[]): Frame {
  return { sessionId: "s1", agentPath: [], seq, receivedAt, kind: "frame", body: { type: "tool_call_update", native: {}, events } };
}

const records: RawEvent[] = [
  { sessionId: "s1", agentPath: [], seq: 0, receivedAt: 0, kind: "request", id: "r1", direction: "toRuntime", body: { kind: "prompt", input: "go" } },
  frame(1, 10, [{ kind: "tool_call_started", callId: "c1", tool: "bash", input: "{\"cwd\":\"/tmp/x\"}" }]),
  frame(2, 20, [{ kind: "tool_call_input", callId: "c1", input: "{\"command\":\"ls\",\"cwd\":\"/tmp/x\"}" }]),
  frame(3, 30, [{ kind: "tool_call_input", callId: "c1", input: "{\"command\":\"ls -a\",\"cwd\":\"/tmp/x\"}" }]),
  frame(4, 40, [{ kind: "tool_call_input", callId: "c9", input: "{\"filePath\":\"a.txt\"}" }]),
];

test("a tool part takes the latest input reported for its call, its state untouched; an input without a start still renders", () => {
  const turn = viewOf(records).messages.find((message) => message.kind === "turn");
  expect(turn?.kind === "turn" ? turn.sections.flatMap((section) => section.parts) : []).toEqual([
    { kind: "tool", callId: "c1", tool: "bash", input: "{\"command\":\"ls -a\",\"cwd\":\"/tmp/x\"}", result: "running", startedAt: 10 },
    { kind: "tool", callId: "c9", tool: "?", input: "{\"filePath\":\"a.txt\"}", result: "running" },
  ]);
});

test("a tool input keeps the status in the call's tool phase and moves the clock", () => {
  const status = records.slice(0, 3).reduce((state, record) => reduceStatus(state, record), initialStatus);
  expect(status).toEqual({ kind: "running", sinceSeq: 0, requestId: "r1", phase: { tool: "bash", callId: "c1" }, lastEventAt: 20 });
});
