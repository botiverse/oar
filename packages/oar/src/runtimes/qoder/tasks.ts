import type { TaskEventBody, TaskStatus } from "../../contracts/tasks.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";

function statusOf(value: unknown): TaskStatus | undefined {
  switch (value) {
    case "pending": case "running": case "paused": case "completed": case "failed": case "stopped": return value;
    case "killed": return "stopped";
    default: return undefined;
  }
}

/** Qoder 1.1.83 native task frames; no inferred background flag or child session. */
export function qoderTaskViews(message: JsonRecord, previousDescription: string | undefined): TaskEventBody[] {
  const taskId = message.task_id;
  if (typeof taskId !== "string" || taskId === "") { return []; }
  switch (message.subtype) {
    case "task_started": return [{ kind: "task_started", taskId, taskType: message.task_type === "local_agent" ? "agent" : "other",
      ...(typeof message.task_type === "string" ? { nativeType: message.task_type } : {}),
      ...(typeof message.description === "string" ? { description: message.description } : {}),
      ...(typeof message.tool_use_id === "string" ? { toolCallId: message.tool_use_id } : {}),
    }];
    case "task_updated": {
      const patch = asRecord(message.patch);
      const status = statusOf(patch?.status);
      return [{ kind: "task_updated", taskId,
        ...(status === undefined ? {} : { status }),
        ...(typeof patch?.description === "string" ? { description: patch.description } : {}),
        ...(typeof patch?.error === "string" ? { error: patch.error } : {}),
      }];
    }
    case "task_progress": return typeof message.description === "string" && message.description !== previousDescription
      ? [{ kind: "task_updated", taskId, description: message.description }] : [];
    case "task_notification": {
      const status = statusOf(message.status);
      if (status !== "completed" && status !== "failed" && status !== "stopped") { return []; }
      return [{ kind: "task_ended", taskId, status,
        ...(typeof message.summary === "string" ? { summary: message.summary } : {}),
        ...(typeof message.output_file === "string" && message.output_file !== "" ? { outputFile: message.output_file } : {}),
      }];
    }
    default: return [];
  }
}
