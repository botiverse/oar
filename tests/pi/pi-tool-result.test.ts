import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { foldPiEvent, initialPiProjection } from "../../packages/oar/src/runtimes/pi/projection.js";

// `tool_execution_end` as pi 0.84.2 emitted it on 2026-09-22 (scratch run,
// seqs 110 and 135): `result` is an AgentToolResult whose `content` text
// parts are the readable output; `details` (the edit's patch) stays native.
function ended(toolName: string, result: unknown, isError = false): AgentSessionEvent {
  return { type: "tool_execution_end", toolCallId: `call_${toolName}`, toolName, result, isError };
}

function events(event: AgentSessionEvent): readonly unknown[] {
  const { commands } = foldPiEvent(initialPiProjection, event);
  return commands[0]?.body.events ?? [];
}

test("pi tool end: the result's content blocks are its ordered parts; details stay in the native frame", () => {
  const bash = ended("bash", { content: [{ type: "text", text: "✔ add (0.29ms)\n✔ mul (0.06ms)\n" }] });
  assert.deepEqual(events(bash), [{ kind: "tool_call_ended", callId: "call_bash", content: [{ type: "text", text: "✔ add (0.29ms)\n✔ mul (0.06ms)\n" }], result: "ok" }]);
  const edit = ended("edit", { content: [{ type: "text", text: "Successfully replaced 1 block(s) in math.js." }], details: { patch: "--- math.js\n+++ math.js\n", firstChangedLine: 1 } });
  assert.deepEqual(events(edit), [{ kind: "tool_call_ended", callId: "call_edit", content: [{ type: "text", text: "Successfully replaced 1 block(s) in math.js." }], result: "ok" }]);
  const two = ended("read", { content: [{ type: "text", text: "a" }, { type: "image", data: "…", mimeType: "image/png" }, { type: "text", text: "b" }] });
  assert.deepEqual(events(two), [{ kind: "tool_call_ended", callId: "call_read", content: [
    { type: "text", text: "a" }, { type: "image", mediaType: "image/png", data: "…" }, { type: "text", text: "b" },
  ], result: "ok" }]);
});

test("pi tool end: an image is an image part, an unknown block is kept whole, a result without blocks is kept whole, and an error keeps its text (#73)", () => {
  const image = ended("screenshot", { content: [{ type: "image", data: "…", mimeType: "image/png" }] });
  assert.deepEqual(events(image), [{ kind: "tool_call_ended", callId: "call_screenshot", content: [{ type: "image", mediaType: "image/png", data: "…" }], result: "ok" }]);
  const resource = { type: "resource", uri: "file:///x" };
  assert.deepEqual(events(ended("custom", { content: [resource] })), [{ kind: "tool_call_ended", callId: "call_custom", content: [{ type: "other", value: resource }], result: "ok" }]);
  assert.deepEqual(events(ended("bare", { details: { n: 1 } })), [{ kind: "tool_call_ended", callId: "call_bare", content: [{ type: "other", value: { details: { n: 1 } } }], result: "ok" }]);
  const failed = ended("bash", { content: [{ type: "text", text: "command not found" }] }, true);
  assert.deepEqual(events(failed), [{ kind: "tool_call_ended", callId: "call_bash", content: [{ type: "text", text: "command not found" }], result: "failed" }]);
});

test("pi tool end: structuredContent.exit_code is surfaced as exitCode; a non-zero exit is still the runtime's result; other tools carry none (#oar-raft)", () => {
  // CodingTools' bash reports the real process exit in structuredContent.
  const zero = ended("bash", { content: [{ type: "text", text: "ok\n" }], structuredContent: { exit_code: 0 } });
  assert.deepEqual(events(zero), [{ kind: "tool_call_ended", callId: "call_bash", content: [{ type: "text", text: "ok\n" }], result: "ok", exitCode: 0 }]);
  // A failing command: pi marks isError, and the exit code rides alongside.
  const failed = ended("bash", { content: [{ type: "text", text: "exit 7\n" }], structuredContent: { exit_code: 7 } }, true);
  assert.deepEqual(events(failed), [{ kind: "tool_call_ended", callId: "call_bash", content: [{ type: "text", text: "exit 7\n" }], result: "failed", exitCode: 7 }]);
  // A signal: pi gives a number, 128 plus the signal (SIGTERM is 143), not null.
  const signalled = ended("bash", { content: [{ type: "text", text: "killed\n" }], structuredContent: { exit_code: 143 } }, true);
  assert.deepEqual(events(signalled), [{ kind: "tool_call_ended", callId: "call_bash", content: [{ type: "text", text: "killed\n" }], result: "failed", exitCode: 143 }]);
  const read = ended("read", { content: [{ type: "text", text: "file body" }] });
  assert.deepEqual(events(read), [{ kind: "tool_call_ended", callId: "call_read", content: [{ type: "text", text: "file body" }], result: "ok" }]);
});
