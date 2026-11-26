import { expect, test } from "vitest";
import { contentBlocks } from "../../packages/oar/src/shared/stream-json/content.js";
import type { RuntimeEventBody } from "../../packages/oar/src/contracts/session.js";
import { foldClaudeStdout, initialClaudeProjection } from "../../packages/oar/src/runtimes/claude/projection.js";
import { CLAUDE_CHECKLIST_TOOL, claudeChecklistTool } from "../../packages/oar/src/runtimes/claude/plan.js";
import type { JsonRecord } from "../../packages/oar/src/shared/json.js";

/**
 * claude sends no plan notification: the only native checklist is the model's
 * own `TodoWrite` call ([src] claude 2.1.332, "Update the todo list for the
 * current session"), whose `todos` argument is the whole list. The call still
 * reads as a tool call; the checklist is a second fact on the same frame,
 * marked `evidence: "tool_call"` (docs/spec/plans.md).
 */
function assistant(blocks: readonly JsonRecord[]): JsonRecord {
  return { type: "assistant", message: { id: "msg_plan", role: "assistant", model: "claude-probe", content: blocks } };
}

function eventsOf(message: JsonRecord): readonly RuntimeEventBody[] {
  return foldClaudeStdout(initialClaudeProjection, message).commands.flatMap((command) => command.kind === "frame" ? command.body.events : []);
}

const todoCall = (todos: unknown, id = "toolu_plan_1"): JsonRecord => ({ type: "tool_use", id, name: CLAUDE_CHECKLIST_TOOL, input: { todos } });

test("a TodoWrite call reads as the call plus one whole-list plan_changed", () => {
  const events = eventsOf(assistant([todoCall([
    { content: "Read the wire shape", status: "in_progress", activeForm: "Reading the wire shape" },
    { content: "Write the spec", status: "pending", activeForm: "Writing the spec" },
  ])]));
  expect(events).toEqual([
    { kind: "tool_call_started", callId: "toolu_plan_1", tool: CLAUDE_CHECKLIST_TOOL, input: JSON.stringify({ todos: [
      { content: "Read the wire shape", status: "in_progress", activeForm: "Reading the wire shape" },
      { content: "Write the spec", status: "pending", activeForm: "Writing the spec" },
    ] }) },
    { kind: "plan_changed", channel: "native", evidence: "tool_call", callId: "toolu_plan_1", plan: { steps: [
      { step: "Read the wire shape", status: "in_progress" },
      { step: "Write the spec", status: "pending" },
    ] } },
  ]);
});

test("an empty todos array is claude's own clear, not a dropped event", () => {
  const observed = eventsOf(assistant([todoCall([])])).filter((event) => event.kind === "plan_changed");
  expect(observed).toEqual([{ kind: "plan_changed", channel: "native", evidence: "tool_call", callId: "toolu_plan_1", plan: { steps: [] } }]);
});

test("another tool call carries no checklist", () => {
  const read = { type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/work/a.ts" } };
  expect(eventsOf(assistant([read])).map((event) => event.kind)).toEqual(["tool_call_started"]);
});

test("a call whose todos OAR cannot read stays the call alone, never an invented empty list", () => {
  const cases: readonly unknown[] = [undefined, "not a list", [{ content: "no status" }], [{ status: "pending" }], [null]];
  for (const todos of cases) {
    const kinds = eventsOf(assistant([todoCall(todos)])).map((event) => event.kind);
    expect(kinds).toEqual(["tool_call_started"]);
  }
  expect(claudeChecklistTool(CLAUDE_CHECKLIST_TOOL, { todos: "not a list" })).toBeNull();
  expect(claudeChecklistTool("Read", { todos: [] })).toBeNull();
});

test("the same rule reads the same checklist offline, from the recorded frame", () => {
  const frame = assistant([todoCall([{ content: "Ship it", status: "completed" }], "toolu_plan_2")]);
  const blocks = contentBlocks(frame);
  expect(blocks).toHaveLength(1);
  const block: JsonRecord = blocks[0] ?? {};
  expect(claudeChecklistTool(String(block.name), block.input)).toEqual({ channel: "native", plan: { steps: [{ step: "Ship it", status: "completed" }] } });
});
