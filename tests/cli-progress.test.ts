import assert from "node:assert/strict";
import { test } from "vitest";
import type { Event, EventBody } from "../packages/oar/src/index.js";
import { createProgressRenderer, renderOpened, renderOutcome } from "../packages/cli/src/progress.js";

let seq = 0;
function at(receivedAt: number, events: EventBody[], agentPath: readonly string[] = []): Event[] {
  seq += 1;
  return events.map((event) => ({ ...event, sessionId: "s-1", agentPath, seq, receivedAt }));
}

/** Render a batch of events read from one record, concatenating their lines. */
function renderAll(render: (event: Event) => readonly string[]): (events: Event[]) => string[] {
  return (events) => events.flatMap((event) => [...render(event)]);
}

test("renderer prints nothing for turn starts, usage, model, effort, empty text, and non-text reasoning", () => {
  const render = renderAll(createProgressRenderer("claude"));
  assert.deepEqual(render(at(0, [{ kind: "turn_started", requestId: "r", input: "hi" }])), []);
  assert.deepEqual(render(at(0, [])), []);
  assert.deepEqual(render(at(1, [{ kind: "text_delta", text: "" }])), []);
  assert.deepEqual(render(at(2, [{ kind: "reasoning", content: { kind: "redacted" } }])), []);
  assert.deepEqual(render(at(3, [{ kind: "reasoning", content: { kind: "empty" } }])), []);
  assert.deepEqual(render(at(4, [{ kind: "reasoning", content: { kind: "text", text: "" } }])), []);
  assert.deepEqual(render(at(5, [{ kind: "model", model: "m" }, { kind: "usage", usage: {} }])), []);
  assert.deepEqual(render(at(6, [{ kind: "effort", effort: "high" }])), []);
});

// The first line of `oar run`: the id to pass back as --resume, and the model
// and effort only when the runtime already said them (the folds, not the flags).
test("renderOpened names the session and whatever model and effort the runtime reported at open", () => {
  assert.equal(renderOpened({ sessionId: "t-1", resumed: false, model: "gpt-5.5", effort: "low" }), "[session t-1 · model gpt-5.5 · effort low]");
  assert.equal(renderOpened({ sessionId: "t-1", resumed: true, model: "gpt-5.5", effort: "high" }), "[resumed t-1 · model gpt-5.5 · effort high]");
  assert.equal(renderOpened({ sessionId: "c-1", resumed: false, model: null, effort: null }), "[session c-1]");
});

test("renderer prints assistant text verbatim and thinking bracketed, one line per view", () => {
  const render = renderAll(createProgressRenderer("claude"));
  assert.deepEqual(render(at(0, [{ kind: "text_delta", text: "The answer is 4." }])), ["The answer is 4."]);
  assert.deepEqual(
    render(at(1, [{ kind: "reasoning", content: { kind: "text", text: "2 + 2..." } }, { kind: "text_delta", text: "4" }])),
    ["[thinking] 2 + 2...", "4"],
  );
});

test("renderer labels tool calls via classifyTool and times them from receivedAt", () => {
  const render = renderAll(createProgressRenderer("claude"));
  const bashInput = JSON.stringify({ command: "echo hi" });
  assert.deepEqual(
    render(at(1000, [{ kind: "tool_call_started", callId: "c1", tool: "Bash", input: bashInput }])),
    ["[Running command] echo hi"],
  );
  assert.deepEqual(render(at(3500, [{ kind: "tool_call_ended", callId: "c1" }])), ["[Ran command] (2.5s)"]);
});

test("renderer handles a tool call without detail and an unknown callId", () => {
  const render = renderAll(createProgressRenderer("codex"));
  assert.deepEqual(render(at(0, [{ kind: "tool_call_started", callId: "c1", tool: "webSearch" }])), ["[Searching the web]"]);
  assert.deepEqual(render(at(100, [{ kind: "tool_call_ended", callId: "never-started" }])), ["[Done]"]);
});

// An ACP runtime can send a call's arguments only after it started (opencode, kimi; issue #147).
test("renderer prints the detail a later tool input adds, once, and nothing for an unknown call", () => {
  const render = renderAll(createProgressRenderer("claude"));
  const command = JSON.stringify({ command: "echo hi" });
  const described = JSON.stringify({ command: "echo hi", description: "Say hi" });
  assert.deepEqual(render(at(0, [{ kind: "tool_call_started", callId: "c1", tool: "Bash" }])), ["[Running command]"]);
  assert.deepEqual(render(at(10, [{ kind: "tool_call_input", callId: "c1", input: command }])), ["[Running command] echo hi"]);
  assert.deepEqual(render(at(20, [{ kind: "tool_call_input", callId: "c1", input: described }])), []);
  assert.deepEqual(render(at(30, [{ kind: "tool_call_input", callId: "c9", input: command }])), []);
  assert.deepEqual(render(at(1000, [{ kind: "tool_call_ended", callId: "c1" }])), ["[Ran command] (1.0s)"]);
});

test("renderer prefixes sub-agent records with their agent path and keys tool calls per agent", () => {
  const render = renderAll(createProgressRenderer("claude"));
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

test("turn_ended renders through renderOutcome; control rejections and exits print bracketed", () => {
  const render = renderAll(createProgressRenderer("claude"));
  assert.deepEqual(render(at(0, [{ kind: "turn_ended", outcome: { kind: "completed" } }])), ["[turn completed]"]);
  assert.deepEqual(render(at(0, [{ kind: "control_rejected", requestId: "r", action: "steer", code: "no_active_turn", reason: "not_steerable" }])), ["[steer rejected] not_steerable"]);
  assert.deepEqual(render(at(0, [{ kind: "exited", code: 143 }])), ["[runtime exited: 143]"]);
});

test("renderer prints compaction, retry and app requests bracketed, and nothing for tool progress or answers", () => {
  const render = renderAll(createProgressRenderer("pi"));
  assert.deepEqual(render(at(0, [{ kind: "compaction_started", trigger: "threshold" }])), ["[compacting: threshold]"]);
  assert.deepEqual(render(at(0, [{ kind: "compaction_ended", outcome: "completed", trigger: "manual" }])), ["[compacted]"]);
  assert.deepEqual(render(at(0, [{ kind: "compaction_ended", outcome: "failed", reason: "boom" }])), ["[compaction failed] boom"]);
  assert.deepEqual(render(at(0, [{ kind: "retry", attempt: 2, maxAttempts: 3, reason: "overloaded" }])), ["[retry 2/3] overloaded"]);
  assert.deepEqual(render(at(0, [{ kind: "app_request", requestId: "p", type: "can_use_tool" }])), ["[waiting for app: can_use_tool]"]);
  assert.deepEqual(render(at(0, [{ kind: "app_request_cancelled", requestId: "p" }])), ["[runtime withdrew its request]"]);
  assert.deepEqual(render(at(0, [{ kind: "tool_call_progress", callId: "c", output: "x" }, { kind: "app_answered", requestId: "p" }])), []);
});


test("renderOpened shows the runtime's actual tier", () => {
  assert.equal(renderOpened({ sessionId: "t", resumed: false, model: null, effort: null, serviceTier: "priority" }), "[session t · tier priority]");
});
