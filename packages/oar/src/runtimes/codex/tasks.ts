import type { TaskEventBody } from "../../contracts/tasks.js";
import type { JsonRecord } from "../../shared/json.js";

/**
 * codex reports its subagents on the parent thread as `subAgentActivity`
 * items (0.149.0 to 0.158.0): `kind` started, interacted, interrupted, and
 * (0.158.0) completed, with the child's `agentThreadId` and its canonical
 * `agentPath` (`/root/name`). The child thread is its own session, so it is
 * the task id and the `childSessionId`. A codex subagent can be given more
 * work after it completed, which `interacted` reports. The projection passes
 * only items about the reporting thread's own child: a thread messaging the
 * root or a sibling reports `interacted` too, and that changes no task.
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

/** The thread that started each subagent thread, by child thread id. */
export type SubagentParents = ReadonlyMap<string, string>;

/** `parents` plus the child a `started` item reported on `reporter`'s thread names. */
export function withStartedChild(parents: SubagentParents, reporter: string, item: JsonRecord | null): SubagentParents {
  const child = item?.type === "subAgentActivity" && item.kind === "started" ? item.agentThreadId : undefined;
  return typeof child === "string" && child.length > 0 && !parents.has(child) ? new Map([...parents, [child, reporter]]) : parents;
}

/**
 * A thread reports `subAgentActivity` on its own thread for its own children
 * and for the messages it sends to peers: on 0.158.0 alpha's `interacted
 * /root/beta` (a sibling) and gamma's `interacted /root` (the root) arrived
 * on alpha's and gamma's threads. Only an item about the reporting thread's
 * own child is a task change or an edge. A child whose start this stream does
 * not hold (started before a resume) is taken to be the reporter's.
 */
export function aboutOwnChild(parents: SubagentParents, rootThreadId: string, reporter: string, item: JsonRecord): boolean {
  if (item.kind === "started") {
    return true;
  }
  const child = item.agentThreadId;
  if (typeof child !== "string" || child === rootThreadId) {
    return false;
  }
  const parent = parents.get(child);
  return parent === undefined || parent === reporter;
}
