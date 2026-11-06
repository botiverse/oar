import { getTextContent, type ChatCompletionRequest, type FixtureResponse } from "@copilotkit/aimock";

/** Choose the next action from accepted input and tool results, never from provider request order. */
export function codexTaskRootReply(request: ChatCompletionRequest): FixtureResponse {
  const completed = (id: string): boolean => request.messages.some(message => message.role === "tool" && message.tool_call_id === id);
  const followup = request.messages.some(message => message.role === "user" && getTextContent(message.content) === "PARENT_FOLLOWUP");
  if (followup) {
    return completed("followup_a") ? { content: "PARENT_OK" } : { toolCalls: [{ id: "followup_a", name: "followup_task", arguments: JSON.stringify({ target: "a", message: "TASK_CHILD_A_RESUME" }) }] };
  }
  if (!completed("spawn_a") || !completed("spawn_b")) {
    const name = completed("spawn_a") ? "b" : "a";
    return { toolCalls: [{ id: `spawn_${name}`, name: "spawn_agent", arguments: JSON.stringify({ task_name: name, message: `TASK_CHILD_${name.toUpperCase()}`, fork_turns: "none" }) }] };
  }
  return { content: "PARENT_OK" };
}
