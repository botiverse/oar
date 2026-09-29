/* oxlint-disable eslint/no-underscore-dangle, import/prefer-default-export, typescript/no-unsafe-call -- Standalone untyped fixture module for fake-acp-agent.mjs. */

/**
 * cursor-agent 2026.09.28 with the `subagents` client capability: the lineage
 * rides the parent's own session/update, then the child speaks under its
 * agent id and the parent hears its terminal state.
 */
export function spawnChildCursor(update) {
  update({ sessionUpdate: "subagent_spawned", subagentSessionId: "fake-child", name: "shell", task: "echo", capabilities: {}, _meta: { cursor: { toolCallId: "call-task", agentId: "fake-child" } } });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "child-says-hi" } }, "fake-child");
  update({ sessionUpdate: "subagent_state_update", subagentSessionId: "fake-child", state: "completed" });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "parent-continues" } });
  return { stopReason: "end_turn" };
}
