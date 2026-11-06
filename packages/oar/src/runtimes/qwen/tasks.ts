import type { TaskEventBody } from "../../contracts/tasks.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";

/** Qwen's SDK adapter nests task fields under data, unlike other stream-json runtimes. */
export function qwenTaskViews(message: JsonRecord): TaskEventBody[] {
  const data = asRecord(message.data);
  if (data === null || typeof data.task_id !== "string" || data.task_id === "") { return []; }
  const taskId = data.task_id;
  if (message.subtype === "task_started") {
    return [{ kind: "task_started", taskId, taskType: typeof data.subagent_type === "string" ? "agent" : "other",
      ...(typeof data.subagent_type === "string" ? { nativeType: data.subagent_type } : {}),
      ...(typeof data.tool_use_id === "string" ? { toolCallId: data.tool_use_id } : {}),
      ...(typeof data.description === "string" ? { description: data.description } : {}),
    }];
  }
  if (message.subtype === "task_notification" && (data.status === "completed" || data.status === "failed" || data.status === "stopped")) {
    return [{ kind: "task_ended", taskId, status: data.status }];
  }
  return [];
}
