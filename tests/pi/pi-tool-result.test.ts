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

test("pi tool end: output is the result's text parts, joined; details stay in the native frame", () => {
  const bash = ended("bash", { content: [{ type: "text", text: "✔ add (0.29ms)\n✔ mul (0.06ms)\n" }] });
  assert.deepEqual(events(bash), [{ kind: "tool_call_ended", callId: "call_bash", output: "✔ add (0.29ms)\n✔ mul (0.06ms)\n", result: "ok" }]);
  const edit = ended("edit", { content: [{ type: "text", text: "Successfully replaced 1 block(s) in math.js." }], details: { patch: "--- math.js\n+++ math.js\n", firstChangedLine: 1 } });
  assert.deepEqual(events(edit), [{ kind: "tool_call_ended", callId: "call_edit", output: "Successfully replaced 1 block(s) in math.js.", result: "ok" }]);
  const two = ended("read", { content: [{ type: "text", text: "a" }, { type: "image", data: "…" }, { type: "text", text: "b" }] });
  assert.deepEqual(events(two), [{ kind: "tool_call_ended", callId: "call_read", output: "a\nb", result: "ok" }]);
});

test("pi tool end: a result without text parts falls back to its JSON, and an error keeps its text", () => {
  const image = ended("screenshot", { content: [{ type: "image", data: "…", mimeType: "image/png" }] });
  assert.deepEqual(events(image), [{ kind: "tool_call_ended", callId: "call_screenshot", output: "{\"content\":[{\"type\":\"image\",\"data\":\"…\",\"mimeType\":\"image/png\"}]}", result: "ok" }]);
  const failed = ended("bash", { content: [{ type: "text", text: "command not found" }] }, true);
  assert.deepEqual(events(failed), [{ kind: "tool_call_ended", callId: "call_bash", output: "command not found", result: "failed" }]);
});
