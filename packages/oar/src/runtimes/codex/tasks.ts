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

/** A subagent thread as its `started` item reported it: the thread that started it, and its canonical path. */
export interface SubagentThread {
  readonly parent: string;
  readonly path?: string;
}

/** Subagent threads by thread id. */
export type SubagentThreads = ReadonlyMap<string, SubagentThread>;

/** The root thread's canonical path (0.158.0: gamma's `interacted` naming the root says `/root`). */
const ROOT_PATH = "/root";

/** `threads` plus the child a `started` item reported on `reporter`'s thread names. */
export function withStartedChild(threads: SubagentThreads, reporter: string, item: JsonRecord | null): SubagentThreads {
  const child = item?.type === "subAgentActivity" && item.kind === "started" ? item.agentThreadId : undefined;
  if (typeof child !== "string" || child.length === 0 || threads.has(child)) {
    return threads;
  }
  const entry = typeof item?.agentPath === "string" ? { parent: reporter, path: item.agentPath } : { parent: reporter };
  return new Map([...threads, [child, entry]]);
}

/** The thread at a canonical path, when the stream has named it. */
function threadAt(threads: SubagentThreads, rootThreadId: string, path: string): string | undefined {
  return path === ROOT_PATH ? rootThreadId : [...threads].find(([, thread]) => thread.path === path)?.[0];
}

/**
 * Whether `path` names a child of `reporter`, judged by the parent path:
 * decided when the parent path's thread is known, or when the reporter's own
 * path is (then the parent is someone else); null when neither is.
 */
function childByPath(threads: SubagentThreads, rootThreadId: string, reporter: string, path: string): boolean | null {
  const parent = threadAt(threads, rootThreadId, path.slice(0, path.lastIndexOf("/")));
  if (parent !== undefined) {
    return parent === reporter;
  }
  return reporter === rootThreadId || threads.get(reporter)?.path !== undefined ? false : null;
}

/**
 * A thread reports `subAgentActivity` on its own thread for its own children
 * and for the messages it sends to peers: on 0.158.0 alpha's `interacted
 * /root/beta` (a sibling) and gamma's `interacted /root` (the root) arrived
 * on alpha's and gamma's threads. Only an item about the reporting thread's
 * own child is a task change or an edge. The child's recorded start decides;
 * without one (started before a resume) its `agentPath` does; when neither
 * the parent path's thread nor the reporter's path is known, the child is
 * taken to be the reporter's.
 */
export function aboutOwnChild(threads: SubagentThreads, rootThreadId: string, reporter: string, item: JsonRecord): boolean {
  const child = item.agentThreadId;
  if (item.kind === "started" || typeof child !== "string") {
    return item.kind === "started";
  }
  const started = threads.get(child);
  if (child === rootThreadId || started !== undefined) {
    return started?.parent === reporter;
  }
  return (typeof item.agentPath === "string" ? childByPath(threads, rootThreadId, reporter, item.agentPath) : null) ?? true;
}
