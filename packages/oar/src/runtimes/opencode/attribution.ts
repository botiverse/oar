import type { TaskEventBody } from "../../contracts/tasks.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import type { AcpSessionProfile } from "../../shared/acp/profile.js";

/** v2 forwards child updates on the root envelope; native metadata owns the identity. */
export const opencodeChildAttribution: NonNullable<AcpSessionProfile["attributeUpdate"]> = (notification) => {
  const envelope = asRecord(notification);
  const update = asRecord(envelope?.update);
  // oxlint-disable-next-line eslint/no-underscore-dangle -- Native ACP extension field.
  const child = asRecord(asRecord(update?._meta)?.["opencode/child-session"]) ?? asRecord(asRecord(envelope?._meta)?.["opencode/child-session"]);
  if (update === null || typeof child?.id !== "string" || child.id === "" || typeof child.parentID !== "string" || child.parentID === "" || child.id === child.parentID) {
    return null;
  }
  return { sessionId: child.id, parent: child.parentID };
};

/**
 * 2.3.0 delivers background children only on this extension, and only to a
 * client that declares `OPENCODE_CHILD_UPDATES` (packages/cli/src/acp/
 * capabilities.ts, child.ts and translate.ts `route` at a6b15d33).
 */
export const OPENCODE_CHILD_UPDATE = "opencode/session/child_update";
export const OPENCODE_CHILD_UPDATES = "opencode/child-session-updates";

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** `{rootSessionId, childSessionId, parentSessionId, depth, title}` with `type: "update"` (a projected SessionUpdate) or `type: "status"`. */
export const opencodeChildUpdate: NonNullable<AcpSessionProfile["childNotification"]> = (method, params) => {
  const sessionId = nonEmpty(params.childSessionId);
  const parent = nonEmpty(params.parentSessionId);
  if (method !== OPENCODE_CHILD_UPDATE || sessionId === null || parent === null || sessionId === parent) { return null; }
  return { sessionId, parent, update: params.type === "update" ? asRecord(params.update) : null };
};

/** The `subagent` tool returns at once with `rawOutput.metadata.sessionID` naming its background child (2.3.0). */
export function opencodeSpawnedSessions(update: JsonRecord): readonly string[] {
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") { return []; }
  const child = nonEmpty(asRecord(asRecord(update.rawOutput)?.metadata)?.sessionID);
  return child === null ? [] : [child];
}

/**
 * Child lifecycle as the parent's tasks, keyed by the child session like Codex
 * child threads. A finished child can take a follow-up (`subagent` with its
 * `sessionID`), which reports `running` again.
 */
export function opencodeChildTasks(method: string, params: JsonRecord): TaskEventBody[] {
  const child = opencodeChildUpdate(method, params);
  if (child === null || params.type !== "status") { return []; }
  const taskId = child.sessionId;
  switch (params.status) {
    case "created":
      return [{ kind: "task_started", taskId, taskType: "agent", childSessionId: taskId, background: true,
        ...(typeof params.title === "string" ? { description: params.title } : {}) }];
    case "running":
      return [{ kind: "task_updated", taskId, status: "running" }];
    case "completed":
      return [{ kind: "task_ended", taskId, status: "completed" }];
    case "failed":
      return [{ kind: "task_ended", taskId, status: "failed" }];
    case "interrupted":
      return [{ kind: "task_ended", taskId, status: "stopped" }];
    default:
      return [];
  }
}
