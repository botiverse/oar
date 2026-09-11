import assert from "node:assert/strict";
import { test } from "vitest";
import type { EventView, SessionRecord } from "../packages/oar/src/index.js";
import { createProgressRenderer, renderOutcome } from "../packages/cli/src/progress.js";

let seq = 0;
function at(receivedAt: number, views: EventView[], agentPath: readonly string[] = []): SessionRecord {
  seq += 1;
  return { sessionId: "s-1", agentPath, seq, receivedAt, kind: "event", body: { type: "fixture", native: {}, views } };
}

test("renderer prints nothing for control records, uninterpreted frames, empty text, and non-text reasoning", () => {
  const render = createProgressRenderer("claude");
  const request: SessionRecord = { sessionId: "s-1", agentPath: [], seq: 0, receivedAt: 0, kind: "request", id: "r", direction: "toRuntime", body: { kind: "prompt", input: "hi" } };
  assert.deepEqual(render(request), []);
  assert.deepEqual(render(at(0, [])), []);
  assert.deepEqual(render(at(1, [{ kind: "text_delta", text: "" }])), []);
  assert.deepEqual(render(at(2, [{ kind: "reasoning", content: { kind: "redacted" } }])), []);
  assert.deepEqual(render(at(3, [{ kind: "reasoning", content: { kind: "empty" } }])), []);
  assert.deepEqual(render(at(4, [{ kind: "reasoning", content: { kind: "text", text: "" } }])), []);
  assert.deepEqual(render(at(5, [{ kind: "model", model: "m" }, { kind: "usage", usage: {} }])), []);
});

test("renderer prints assistant text verbatim and thinking bracketed, one line per view", () => {
  const render = createProgressRenderer("claude");
  assert.deepEqual(render(at(0, [{ kind: "text_delta", text: "The answer is 4." }])), ["The answer is 4."]);
  assert.deepEqual(
    render(at(1, [{ kind: "reasoning", content: { kind: "text", text: "2 + 2..." } }, { kind: "text_delta", text: "4" }])),
    ["[thinking] 2 + 2...", "4"],
  );
});

test("renderer labels tool calls via classifyTool and times them from receivedAt", () => {
  const render = createProgressRenderer("claude");
  const bashInput = JSON.stringify({ command: "echo hi" });
  assert.deepEqual(
    render(at(1000, [{ kind: "tool_call_started", callId: "c1", tool: "Bash", input: bashInput }])),
    ["[Running command] echo hi"],
  );
  assert.deepEqual(render(at(3500, [{ kind: "tool_call_ended", callId: "c1" }])), ["[Ran command] (2.5s)"]);
});

test("renderer handles a tool call without detail and an unknown callId", () => {
  const render = createProgressRenderer("codex");
  assert.deepEqual(render(at(0, [{ kind: "tool_call_started", callId: "c1", tool: "webSearch" }])), ["[Searching the web]"]);
  assert.deepEqual(render(at(100, [{ kind: "tool_call_ended", callId: "never-started" }])), ["[Done]"]);
});

test("renderer prefixes sub-agent records with their agent path and keys tool calls per agent", () => {
  const render = createProgressRenderer("claude");
  assert.deepEqual(render(at(0, [{ kind: "tool_call_started", callId: "c1", tool: "Read" }], ["task-1"])), ["[task-1] [Reading file]"]);
  assert.deepEqual(render(at(0, [{ kind: "tool_call_started", callId: "c1", tool: "Bash" }])), ["[Running command]"]);
  assert.deepEqual(render(at(500, [{ kind: "tool_call_ended", callId: "c1" }], ["task-1"])), ["[task-1] [Read file] (0.5s)"]);
  assert.deepEqual(render(at(1000, [{ kind: "tool_call_ended", callId: "c1" }])), ["[Ran command] (1.0s)"]);
});

test("renderOutcome covers completed, aborted, and failed", () => {
  assert.equal(renderOutcome({ kind: "completed" }), "[turn completed]");
  assert.equal(renderOutcome({ kind: "aborted" }), "[turn aborted]");
  assert.equal(
    renderOutcome({ kind: "failed", reason: "credit balance too low", failure: "quota" }),
    "[turn failed: quota] credit balance too low",
  );
});

test("turn_ended renders through renderOutcome", () => {
  const render = createProgressRenderer("claude");
  assert.deepEqual(render(at(0, [{ kind: "turn_ended", outcome: { kind: "completed" } }])), ["[turn completed]"]);
});
