import type { TaskEventBody } from "../../contracts/tasks.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";

/** Grok 1.0.77 reports task lifecycle on the parent's extension stream. */
export function grokTaskViews(method: string, params: JsonRecord): TaskEventBody[] {
  if (method !== "_x.ai/session_notification") { return []; }
  const update = asRecord(params.update);
  const taskId = update?.subagent_id;
  if (update === null || typeof taskId !== "string" || taskId === "") { return []; }
  if (update.sessionUpdate === "subagent_spawned") {
    return [{ kind: "task_started", taskId, taskType: "agent",
      ...(typeof update.subagent_type === "string" ? { nativeType: update.subagent_type } : {}),
      ...(typeof update.description === "string" ? { description: update.description } : {}),
      ...(typeof update.child_session_id === "string" ? { childSessionId: update.child_session_id } : {}),
    }];
  }
  if (update.sessionUpdate === "subagent_finished" && (update.status === "completed" || update.status === "failed" || update.status === "stopped")) {
    return [{ kind: "task_ended", taskId, status: update.status }];
  }
  return [];
}
