import type { TaskEventBody } from "../../contracts/tasks.js";
import type { JsonRecord } from "../../shared/json.js";

/**
 * codex reports its subagents on the parent thread as `subAgentActivity`
 * items (0.149.0 to 0.158.0): `kind` started, interacted, interrupted, and
 * (0.158.0) completed, with the child's `agentThreadId` and its canonical
 * `agentPath` (`/root/name`). The child thread is its own session, so it is
 * the task id and the `childSessionId`. A codex subagent can be given more
 * work after it completed, which `interacted` reports.
 */
export function codexTaskViews(item: JsonRecord): TaskEventBody[] {
  const taskId = typeof item.agentThreadId === "string" && item.agentThreadId !== "" ? item.agentThreadId : undefined;
  if (item.type !== "subAgentActivity" || taskId === undefined) {
    return [];
  }
  switch (item.kind) {
    case "started":
      return [{
        kind: "task_started",
        taskId,
        taskType: "agent",
        nativeType: "subAgent",
        childSessionId: taskId,
        background: true,
        ...(typeof item.agentPath === "string" ? { description: item.agentPath } : {}),
        ...(typeof item.id === "string" ? { toolCallId: item.id } : {}),
      }];
    case "interacted":
      return [{ kind: "task_updated", taskId, status: "running" }];
    case "completed":
      return [{ kind: "task_ended", taskId, status: "completed" }];
    case "interrupted":
      return [{ kind: "task_ended", taskId, status: "stopped" }];
    default:
      return [];
  }
}
