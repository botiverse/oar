import { expect, test } from "vitest";
import { foldClaudeStdout, initialClaudeProjection } from "../../packages/oar/src/runtimes/claude/projection.js";
import type { JsonRecord } from "../../packages/oar/src/shared/json.js";

function reader() {
  let state = initialClaudeProjection;
  return (message: JsonRecord) => {
    const result = foldClaudeStdout(state, { type: "system", task_id: "task", ...message });
    ({ state } = result);
    return result.commands.flatMap((command) => command.kind === "frame" ? command.body.events : []);
  };
}

test.each([
  ["local_bash", "shell"], ["local_agent", "agent"], ["remote_agent", "agent"],
  ["in_process_teammate", "agent"], ["mcp_task", "tool"], ["local_workflow", "workflow"], ["future_type", "other"],
])("%s maps to %s and reports only changes to its description", (task_type, taskType) => {
  const read = reader();
  expect(read({ subtype: "task_started", task_type, description: "one" }))
    .toEqual([{ kind: "task_started", taskId: "task", taskType, nativeType: task_type, description: "one" }]);
  expect(read({ subtype: "task_progress", description: "one", usage: { total_tokens: 500 } })).toEqual([]);
  expect(read({ subtype: "task_progress", description: "two" })).toEqual([{ kind: "task_updated", taskId: "task", description: "two" }]);
  expect(read({ subtype: "task_updated", patch: { description: "three" } })).toEqual([{ kind: "task_updated", taskId: "task", description: "three" }]);
  expect(read({ subtype: "task_progress", description: "three" })).toEqual([]);
  expect(read({ subtype: "task_progress", description: "" })).toEqual([{ kind: "task_updated", taskId: "task", description: "" }]);
  expect(read({ subtype: "task_progress", description: "" })).toEqual([]);
});

test("progress identity is per agent/task; incomplete progress is preserved without inventing a description", () => {
  const read = reader();
  const progress = { subtype: "task_progress", description: "same" };
  expect(read(progress)).toHaveLength(1);
  expect(read({ ...progress, task_id: "other" })).toHaveLength(1);
  expect(read({ ...progress, parent_tool_use_id: "child" })).toHaveLength(1);
  expect(read(progress)).toEqual([]);
  expect(read({ ...progress, task_id: null })).toEqual([]);
  expect(read({ subtype: "task_progress", description: null, last_tool_name: "Bash", summary: "not the description" })).toEqual([]);
  expect(read({ subtype: "task_progress" })).toEqual([]);
});
