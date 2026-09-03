import assert from "node:assert/strict";
import { test } from "vitest";
import type { SessionEvent, SessionEventBody } from "../packages/oar/src/index.js";
import { createProgressRenderer, renderOutcome } from "../packages/cli/src/progress.js";

let seq = 0;
function at(receivedAt: number, body: SessionEventBody): SessionEvent {
  seq += 1;
  return { sessionId: "s-1", turnId: "t-1", seq, receivedAt, ...body };
}

test("renderer skips turn_started, empty text, and non-text reasoning", () => {
  const render = createProgressRenderer("claude");
  assert.equal(render(at(0, { kind: "turn_started" })), null);
  assert.equal(render(at(1, { kind: "text_delta", text: "" })), null);
  assert.equal(render(at(2, { kind: "reasoning", content: { kind: "redacted" } })), null);
  assert.equal(render(at(3, { kind: "reasoning", content: { kind: "empty" } })), null);
  assert.equal(render(at(4, { kind: "reasoning", content: { kind: "text", text: "" } })), null);
});

test("renderer prints assistant text verbatim and thinking bracketed", () => {
  const render = createProgressRenderer("claude");
  assert.equal(render(at(0, { kind: "text_delta", text: "The answer is 4." })), "The answer is 4.");
  assert.equal(
    render(at(1, { kind: "reasoning", content: { kind: "text", text: "2 + 2..." } })),
    "[thinking] 2 + 2...",
  );
});

test("renderer labels tool calls via classifyTool and times them from receivedAt", () => {
  const render = createProgressRenderer("claude");
  const bashInput = JSON.stringify({ command: "echo hi" });
  assert.equal(
    render(at(1000, {
      kind: "tool_call_started",
      callId: "c1",
      tool: "Bash",
      input: bashInput,
    })),
    "[Running command] echo hi",
  );
  assert.equal(
    render(at(3500, { kind: "tool_call_ended", callId: "c1" })),
    "[Ran command] (2.5s)",
  );
});

test("renderer handles a tool call without detail and an unknown callId", () => {
  const render = createProgressRenderer("codex");
  assert.equal(
    render(at(0, { kind: "tool_call_started", callId: "c1", tool: "webSearch" })),
    "[Searching the web]",
  );
  assert.equal(render(at(100, { kind: "tool_call_ended", callId: "never-started" })), "[Done]");
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
  assert.equal(
    render(at(0, { kind: "turn_ended", outcome: { kind: "completed" } })),
    "[turn completed]",
  );
});
