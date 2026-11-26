import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { foldPiEvent, initialPiProjection } from "../../packages/oar/src/runtimes/pi/projection.js";
import { TODO_WRITE_TOOL } from "../../packages/oar/src/shared/todo-write-plan.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";

/**
 * Pi registers no checklist tool of its own. The one Hikari installs names
 * itself `TodoWrite` and takes the whole list in `todos`
 * ([src] `pi-runtime/todo-write.ts`: `{content, status, activeForm?}` items),
 * the same shape claude's built-in tool takes. OAR therefore reads the call as
 * a checklist with `channel: "extension"`: the call proves the tool ran, not
 * which extension provided it, so no identity is claimed.
 */
function started(toolName: string, args: unknown, toolCallId = `call_${toolName}`): AgentSessionEvent {
  return { type: "tool_execution_start", toolCallId, toolName, args };
}

function kinds(list: readonly unknown[]): readonly string[] {
  return list.map((event) => {
    const record = asRecord(event);
    return typeof record?.kind === "string" ? record.kind : "?";
  });
}

function events(event: AgentSessionEvent): readonly unknown[] {
  const { commands } = foldPiEvent(initialPiProjection, event);
  return commands[0]?.body.events ?? [];
}

test("a pi TodoWrite call reads as the call plus one whole-list plan_changed from an extension", () => {
  const todos = [
    { content: "Read the plugin contract", status: "in_progress", activeForm: "Reading the plugin contract" },
    { content: "Wire the checklist", status: "pending", activeForm: "Wiring the checklist" },
  ];
  assert.deepEqual(events(started(TODO_WRITE_TOOL, { todos })), [
    { kind: "tool_call_started", callId: "call_TodoWrite", tool: TODO_WRITE_TOOL, input: JSON.stringify({ todos }) },
    { kind: "plan_changed", channel: "extension", evidence: "tool_call", callId: "call_TodoWrite", plan: { steps: [
      { step: "Read the plugin contract", status: "in_progress" },
      { step: "Wire the checklist", status: "pending" },
    ] } },
  ]);
});

test("an empty todos array is the plugin's own clear, and no identity is claimed", () => {
  const [call, plan] = events(started(TODO_WRITE_TOOL, { todos: [] }));
  assert.deepEqual(call, { kind: "tool_call_started", callId: "call_TodoWrite", tool: TODO_WRITE_TOOL, input: JSON.stringify({ todos: [] }) });
  assert.deepEqual(plan, { kind: "plan_changed", channel: "extension", evidence: "tool_call", callId: "call_TodoWrite", plan: { steps: [] } });
  const fields = Object.keys(asRecord(plan) ?? {});
  assert.equal(fields.includes("extension"), false, "the wire names no extension, so OAR claims none");
});

test("a pi tool that is not TodoWrite, or a TodoWrite call OAR cannot read, is the call alone", () => {
  const other = events(started("bash", { command: "ls" }));
  assert.deepEqual(kinds(other), ["tool_call_started"]);
  for (const todos of [undefined, "not a list", [{ content: "no status" }], [{ status: "pending" }], [null]]) {
    const unreadable = events(started(TODO_WRITE_TOOL, { todos }));
    assert.deepEqual(kinds(unreadable), ["tool_call_started"]);
  }
});
