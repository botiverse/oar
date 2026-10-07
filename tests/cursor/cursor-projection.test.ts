import assert from "node:assert/strict";
import { test } from "vitest";
import {
  cursorOpenedFrame,
  cursorRunFailedFrame,
  cursorRunResultFrame,
  foldCursorDelta,
  initialCursorProjection,
  type CursorFrame,
  type CursorProjectionState,
} from "../../packages/oar/src/runtimes/cursor/projection.js";

// `onDelta` updates as `@cursor/sdk` 1.0.35 sent them on 2026-10-03
// (composer-2.5, research probe in /tmp/cursor-probe-cwd).

function fold(updates: readonly unknown[]): { state: CursorProjectionState; frames: CursorFrame[] } {
  let state = initialCursorProjection;
  const frames: CursorFrame[] = [];
  for (const update of updates) {
    const { state: next, frame } = foldCursorDelta(state, update);
    state = next;
    frames.push(frame);
  }
  return { state, frames };
}

const one = (update: unknown): CursorFrame => {
  const { frames: [frame] } = fold([update]);
  return frame ?? assert.fail("no frame");
};

test("text and thinking pieces are text and reasoning; bookkeeping updates are frames with no events", () => {
  assert.deepEqual(one({ type: "text-delta", text: "OAR-BASIC" }).events, [{ kind: "text_delta", text: "OAR-BASIC" }]);
  assert.deepEqual(one({ type: "thinking-delta", text: "I will reply" }).events, [{ kind: "reasoning", content: { kind: "text", text: "I will reply" } }]);
  for (const update of [
    { type: "token-delta", tokens: 6 },
    { type: "thinking-completed", thinkingDurationMs: 1 },
    { type: "step-completed", stepId: 2, stepDurationMs: 1015 },
    { type: "tool-requests-listed", callCount: 1 },
  ]) {
    const frame = one(update);
    assert.equal(frame.type, update.type);
    assert.deepEqual(frame.events, []);
    assert.equal(frame.native, update);
  }
});

test("a shell call: its args are the input, stdout and stderr the content, and the exit code is the shell's", () => {
  const callId = "tool_d871adfa-2316-4bbe-b12e-6efe83976a8";
  const args = { command: "ls /definitely/not/here", timeout: 30_000 };
  assert.deepEqual(one({ type: "tool-call-started", callId, toolCall: { type: "shell", args }, modelCallId: "m-0" }).events, [
    { kind: "tool_call_started", callId, tool: "shell", input: JSON.stringify(args) },
  ]);
  const value = { exitCode: 2, signal: "", stdout: "", stderr: "ls: cannot access '/definitely/not/here': No such file or directory\n", executionTime: 426 };
  // The tool ran, so cursor says success; the command's own failure is its exit code.
  assert.deepEqual(one({ type: "tool-call-completed", callId, toolCall: { type: "shell", args, result: { status: "success", value } }, modelCallId: "m-0" }).events, [
    { kind: "tool_call_ended", callId, content: [{ type: "text", text: value.stderr }], result: "ok", exitCode: 2 },
  ]);
});

test("a read is the file text, an edit its diff, an error its message, anything else kept whole", () => {
  const ended = (tool: string, result: unknown): unknown => one({ type: "tool-call-completed", callId: "c", toolCall: { type: tool, args: {}, result } }).events[0];
  assert.deepEqual(ended("read", { status: "success", value: { content: "KIWI", totalLines: 1, fileSize: 4 } }), {
    kind: "tool_call_ended", callId: "c", content: [{ type: "text", text: "KIWI" }], result: "ok",
  });
  assert.deepEqual(ended("edit", { status: "success", value: { linesAdded: 1, linesRemoved: 0, diffString: "--- /dev/null\n+++ b/note.txt\n@@ -1,0 +1 @@\n+KIWI" } }), {
    kind: "tool_call_ended", callId: "c", content: [{ type: "text", text: "--- /dev/null\n+++ b/note.txt\n@@ -1,0 +1 @@\n+KIWI" }], result: "ok",
  });
  assert.deepEqual(ended("grep", { status: "error", error: { message: "no such path" } }), {
    kind: "tool_call_ended", callId: "c", content: [{ type: "text", text: "no such path" }], result: "failed",
  });
  assert.deepEqual(ended("glob", { status: "success", value: { files: ["a.ts"] } }), {
    kind: "tool_call_ended", callId: "c", content: [{ type: "other", value: { files: ["a.ts"] } }], result: "ok",
  });
  assert.deepEqual(ended("ls", undefined), { kind: "tool_call_ended", callId: "c" });
  // A command that printed nothing still reported a result; one a signal ended has no exit code.
  assert.deepEqual(ended("shell", { status: "success", value: { exitCode: 0, signal: "", stdout: "", stderr: "" } }), {
    kind: "tool_call_ended", callId: "c", content: [{ type: "text", text: "" }], result: "ok", exitCode: 0,
  });
  assert.deepEqual(ended("shell", { status: "success", value: { exitCode: 143, signal: "SIGTERM", stdout: "", stderr: "" } }), {
    kind: "tool_call_ended", callId: "c", content: [{ type: "text", text: "" }], result: "ok", exitCode: null,
  });
});

test("a delivered steer's echo is a user message without an input id", () => {
  const update = {
    type: "user-message-appended",
    userMessage: { type: "user_message", session_id: "agent-c6bb8dd0-8424-4f34-a4ca-f2073a590ef6", text: "Also include the word PELICAN in your final reply." },
  };
  assert.deepEqual(one(update).events, [{ kind: "user_message", input: "Also include the word PELICAN in your final reply.", evidence: "conversation" }]);
});

// #161: cacheReadTokens / cacheWriteTokens (required in SDK 1.0.36's
// TurnEndedUpdateSchema) are parts of input, accumulated across turns like
// it; a reported 0 stays 0.
test("each turn's usage adds to a running total, cache reads and writes counted as input and as its parts", () => {
  const { frames } = fold([
    { type: "turn-ended", usage: { inputTokens: 11_703, outputTokens: 60, cacheReadTokens: 8224, cacheWriteTokens: 0 } },
    { type: "turn-ended", usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 10, cacheWriteTokens: 1 } },
  ]);
  assert.deepEqual(frames.map((frame) => frame.events), [
    [{ kind: "usage", usage: { tokens: { input: 19_927, output: 60, cacheRead: 8224, cacheWrite: 0 } } }],
    [{ kind: "usage", usage: { tokens: { input: 20_038, output: 65, cacheRead: 8234, cacheWrite: 1 } } }],
  ]);
});

test("a subagent's update arrives inside its task call and is attributed to that call", () => {
  const task = "tool_6c5cfdce-eb31-45c3-8289-96cc208c30b";
  const child = "tool_d7604d47-1112-4faf-9585-cae23e01b41";
  const { frames } = fold([
    { type: "tool-call-delta", callId: task, modelCallId: "m-1", taskUpdate: { type: "thinking-delta", text: "Running a shell command" } },
    { type: "tool-call-delta", callId: task, modelCallId: "m-1", taskUpdate: { type: "tool-call-started", callId: child, toolCall: { type: "shell", args: { command: "ls -la" } } } },
    { type: "tool-call-delta", callId: task, modelCallId: "m-1", taskUpdate: { type: "text-delta", text: "Here" } },
    // SDK 1.0.35's schema allows no nesting deeper than this; one would unwrap the same way.
    { type: "tool-call-delta", callId: task, modelCallId: "m-1", taskUpdate: { type: "tool-call-delta", callId: "grandchild-task", taskUpdate: { type: "text-delta", text: "deep" } } },
    { type: "turn-ended", usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } },
  ]);
  assert.deepEqual(frames.map((frame) => [frame.type, frame.agentPath]), [
    ["tool-call-delta", [task]],
    ["tool-call-delta", [task]],
    ["tool-call-delta", [task]],
    ["tool-call-delta", [task, "grandchild-task"]],
    ["turn-ended", []],
  ]);
  assert.deepEqual(frames[1]?.events, [{ kind: "tool_call_started", callId: child, tool: "shell", input: JSON.stringify({ command: "ls -la" }) }]);
  assert.deepEqual(frames[3]?.events, [{ kind: "text_delta", text: "deep" }]);
  // The run's own usage is recorded on the root.
  assert.deepEqual(frames[4]?.events, [{ kind: "usage", usage: { tokens: { input: 7, output: 2, cacheRead: 0, cacheWrite: 0 } } }]);
});

test("a run's status is the turn's outcome, and its model and effort what the SDK records it ran", () => {
  const finished = cursorRunResultFrame({ id: "run-1", status: "finished", result: "EFFORT-OK", model: { id: "gpt-5.4-mini", params: [{ id: "reasoning", value: "low" }] }, durationMs: 4129 });
  assert.equal(finished.type, "cursor/run_result");
  assert.deepEqual(finished.events, [
    { kind: "model", model: "gpt-5.4-mini" },
    { kind: "effort", effort: "low" },
    { kind: "turn_ended", outcome: { kind: "completed" } },
  ]);
  assert.deepEqual(cursorRunResultFrame({ id: "run-2", status: "cancelled", model: { id: "composer-2.5" } }).events, [
    { kind: "model", model: "composer-2.5" },
    { kind: "turn_ended", outcome: { kind: "aborted" } },
  ]);
  assert.deepEqual(cursorRunResultFrame({ id: "run-3", status: "error", error: { message: "[unknown] Invalid User API Key" } }).events, [
    { kind: "turn_ended", outcome: { kind: "failed", reason: "[unknown] Invalid User API Key", failure: "auth" } },
  ]);
  assert.deepEqual(cursorRunFailedFrame("socket hang up").events, [
    { kind: "turn_ended", outcome: { kind: "failed", reason: "socket hang up", failure: "unknown" } },
  ]);
});

test("the opened agent reports the model the SDK resolved", () => {
  assert.deepEqual(cursorOpenedFrame("agent-1", { id: "composer-2.5" }).events, [{ kind: "model", model: "composer-2.5" }]);
  assert.deepEqual(cursorOpenedFrame("agent-1", { id: "claude-opus-5-5", params: [{ id: "context", value: "1m" }, { id: "effort", value: "max" }] }).events, [
    { kind: "model", model: "claude-opus-5-5" },
    { kind: "effort", effort: "max" },
  ]);
  assert.deepEqual(cursorOpenedFrame("agent-1", undefined).events, []);
});
