import assert from "node:assert/strict";
import { test } from "vitest";
import type { EventView } from "../../packages/oar/src/contracts/session.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { createAcpProjectionState, projectAcpUpdate, type AcpProjectionState } from "../../packages/oar/src/shared/acp/projection.js";
import type { JsonRecord } from "../../packages/oar/src/shared/json.js";
import { describe, start } from "../fixtures/acp-session-support.js";

// Frames as kimi 0.42.0 sent them on 2026-09-11 (oar-trial-run/live-kimi-a/
// tool-detail.voyage.jsonl seqs 12, 25, 35 and live-kimi-c/subagent.voyage.jsonl
// seqs 13, 69), session id, terminal id and the Agent report shortened.
const BASH_ID = "0:tool_xRsGw1smHmgUciSAgVqpGdac";
const AGENT_ID = "0:tool_XDTuEZqRATUtpXLvx4Vu30C1";
const AGENT_REPORT = "agent_id: agent-0\nactual_subagent_type: coder\nstatus: completed";

function textContent(text: string): JsonRecord[] {
  return [{ content: { text, type: "text" }, type: "content" }];
}

/** The opening `tool_call` carries the tool's name only as `title`, and no `rawInput`. */
function opening(state: AcpProjectionState, toolCallId: string, tool: { readonly title: string; readonly kind: string }): EventView[] {
  return projectAcpUpdate(state, { toolCallId, ...tool, status: "pending", content: textContent(""), sessionUpdate: "tool_call" });
}

test("kimi tool frames: the tool label is the opening title, not the ACP kind, and the input is not known at the start", () => {
  const state = createAcpProjectionState();
  assert.deepEqual(opening(state, BASH_ID, { title: "Bash", kind: "execute" }), [{ kind: "tool_call_started", callId: BASH_ID, tool: "Bash" }]);
  // The arguments stream as `content` text and land as `rawInput` on a later update.
  const later = projectAcpUpdate(state, {
    toolCallId: BASH_ID,
    kind: "execute",
    status: "in_progress",
    title: "Running: echo TOOL-MARK-4412",
    content: textContent("{\"command\":\"echo TOOL-MARK-4412\"}"),
    rawInput: { command: "echo TOOL-MARK-4412" },
    sessionUpdate: "tool_call_update",
  });
  assert.deepEqual(later, [], "a later rawInput cannot reopen the started view");
  assert.deepEqual(opening(state, AGENT_ID, { title: "Agent", kind: "other" }), [{ kind: "tool_call_started", callId: AGENT_ID, tool: "Agent" }]);
});

test("kimi tool ends: the terminal tool's completed frame is a terminal reference, the Agent tool's carries its report", () => {
  const state = createAcpProjectionState();
  opening(state, BASH_ID, { title: "Bash", kind: "execute" });
  opening(state, AGENT_ID, { title: "Agent", kind: "other" });
  const terminal = projectAcpUpdate(state, {
    toolCallId: BASH_ID,
    status: "completed",
    content: [{ terminalId: "bb80f18f", type: "terminal" }],
    sessionUpdate: "tool_call_update",
  });
  assert.deepEqual(terminal, [{ kind: "tool_call_ended", callId: BASH_ID, output: "[{\"terminalId\":\"bb80f18f\",\"type\":\"terminal\"}]", result: "ok" }]);
  const agent = projectAcpUpdate(state, {
    toolCallId: AGENT_ID,
    status: "completed",
    content: textContent(AGENT_REPORT),
    rawOutput: AGENT_REPORT,
    sessionUpdate: "tool_call_update",
  });
  assert.deepEqual(agent, [{ kind: "tool_call_ended", callId: AGENT_ID, output: AGENT_REPORT, result: "ok" }]);
});

test("ACP tool_call_update maps failed status and omits result when status is absent", () => {
  const failed = projectAcpUpdate(createAcpProjectionState(), {
    toolCallId: "failed",
    status: "failed",
    rawOutput: "boom",
    sessionUpdate: "tool_call_update",
  });
  assert.deepEqual(failed, [{ kind: "tool_call_started", callId: "failed", tool: "tool" }, { kind: "tool_call_ended", callId: "failed", output: "boom", result: "failed" }]);
  const unknown = projectAcpUpdate(createAcpProjectionState(), {
    toolCallId: "unknown",
    rawOutput: "?",
    sessionUpdate: "tool_call_update",
  });
  assert.deepEqual(unknown, [{ kind: "tool_call_started", callId: "unknown", tool: "tool" }]);
});

test("a name-bearing frame still labels the tool by name, and a kind-only frame by kind", () => {
  const state = createAcpProjectionState();
  assert.deepEqual(
    projectAcpUpdate(state, { toolCallId: "a", name: "Read", kind: "read", title: "Read input.txt", sessionUpdate: "tool_call" }),
    [{ kind: "tool_call_started", callId: "a", tool: "Read" }],
  );
  assert.deepEqual(
    projectAcpUpdate(state, { toolCallId: "b", kind: "search", sessionUpdate: "tool_call" }),
    [{ kind: "tool_call_started", callId: "b", tool: "search" }],
  );
  // Precedence: name > toolName > title (opening frame only) > kind.
  assert.deepEqual(
    projectAcpUpdate(state, { toolCallId: "c", toolName: "Bash", kind: "execute", title: "Running: echo hi", sessionUpdate: "tool_call" }),
    [{ kind: "tool_call_started", callId: "c", tool: "Bash" }],
  );
});

test("a call first seen on a tool_call_update is not labelled by that frame's progress title", () => {
  const state = createAcpProjectionState();
  // The opening frame was missed (a cursor past it, a runtime that never sent
  // one): the update's `title` is progress text, so the label is the kind.
  assert.deepEqual(
    projectAcpUpdate(state, { toolCallId: BASH_ID, kind: "execute", status: "in_progress", title: "Running: echo TOOL-MARK-4412", rawInput: { command: "echo TOOL-MARK-4412" }, sessionUpdate: "tool_call_update" }),
    [{ kind: "tool_call_started", callId: BASH_ID, tool: "execute", input: "{\"command\":\"echo TOOL-MARK-4412\"}" }],
  );
  // With a name on the update, the name still wins.
  assert.deepEqual(
    projectAcpUpdate(state, { toolCallId: "d", toolName: "Bash", title: "Running: ls", sessionUpdate: "tool_call_update" }),
    [{ kind: "tool_call_started", callId: "d", tool: "Bash" }],
  );
});

// kimi 0.42.0 kill-runtime run (oar-trial-run/live-kimi-c/kill-runtime.voyage.jsonl,
// 2026-09-11): after SIGKILL the `exited` response (seq 120) points at no
// request and the later dispose request (seq 123) had no answer at all.
async function killedByFixture(): Promise<Awaited<ReturnType<typeof start>>> {
  const session = await start();
  const exited = await promptAndWait(session, "exit");
  assert.equal(exited.kind, "ended");
  const exit = session.records().find((record) => record.kind === "response" && record.body.kind === "exited");
  assert.ok(exit?.kind === "response" && exit.requestId === "", "the exit points at no request");
  return session;
}

test("a dispose after an unrequested exit is answered accepted, the exit itself staying unrequested", async () => {
  const session = await killedByFixture();
  await session.dispose();
  assert.deepEqual(session.records().slice(-2).map((record) => describe(record)), ["request dispose", "response accepted"]);
  const [dispose, answer] = session.records().slice(-2);
  assert.ok(dispose?.kind === "request" && answer?.kind === "response" && answer.requestId === dispose.id);
  const after = await session.prompt("after dispose");
  assert.equal(after.response.body.kind, "rejected");
  await session.dispose();
});
