import type { TaskEventBody, TaskStatus, TaskType } from "../../contracts/tasks.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";

/**
 * claude's task frames (stream-json `system/task_started`, `task_updated`,
 * `task_progress`, `task_notification`; observed on 2.1.284 and 2.1.292, shapes as documented for the
 * Agent SDK): background and foreground commands (`local_bash`), subagents
 * (`local_agent`, `remote_agent`), and MCP calls moved to the background
 * (`mcp_task`), workflow runs (`local_workflow`) and agent teammates.
 * `workflow_progress` stays native: it is outside the SDK schema. Its
 * last-call token counts are not spend; only result.modelUsage is.
 * `background_tasks_changed` repeats the live set and maps to
 * nothing: the per-task frames carry starts, status changes and ends, though
 * a change of `ambient` alone shows only there.
 */

const TASK_TYPES: Readonly<Record<string, TaskType>> = {
  local_bash: "shell",
  local_agent: "agent",
  remote_agent: "agent",
  in_process_teammate: "agent",
  mcp_task: "tool",
  local_workflow: "workflow",
};

const STATUSES: Readonly<Record<string, TaskStatus>> = {
  pending: "pending",
  running: "running",
  paused: "paused",
  completed: "completed",
  failed: "failed",
  killed: "stopped",
  stopped: "stopped",
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function flag(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function started(message: JsonRecord, taskId: string): TaskEventBody {
  const nativeType = text(message.task_type);
  const description = text(message.description);
  const toolCallId = text(message.tool_use_id);
  const background = flag(message.is_backgrounded);
  const ambient = flag(message.ambient);
  return {
    kind: "task_started",
    taskId,
    taskType: nativeType === undefined ? "other" : TASK_TYPES[nativeType] ?? "other",
    ...(nativeType === undefined ? {} : { nativeType }),
    ...(description === undefined ? {} : { description }),
    ...(toolCallId === undefined ? {} : { toolCallId }),
    ...(background === undefined ? {} : { background }),
    ...(ambient === undefined ? {} : { ambient }),
  };
}

function updated(message: JsonRecord, taskId: string): TaskEventBody {
  const patch = asRecord(message.patch) ?? {};
  const status = typeof patch.status === "string" ? STATUSES[patch.status] : undefined;
  const background = flag(patch.is_backgrounded);
  const description = text(patch.description);
  const error = text(patch.error);
  return {
    kind: "task_updated",
    taskId,
    ...(status === undefined ? {} : { status }),
    ...(background === undefined ? {} : { background }),
    ...(description === undefined ? {} : { description }),
    ...(error === undefined ? {} : { error }),
  };
}

function ended(message: JsonRecord, taskId: string): TaskEventBody[] {
  const status = typeof message.status === "string" ? STATUSES[message.status] : undefined;
  if (status !== "completed" && status !== "failed" && status !== "stopped") {
    return [];
  }
  const summary = text(message.summary);
  const outputFile = text(message.output_file);
  return [{
    kind: "task_ended",
    taskId,
    status,
    ...(summary === undefined ? {} : { summary }),
    ...(outputFile === undefined ? {} : { outputFile }),
  }];
}

function taskEvents(message: JsonRecord, previousDescription: string | undefined): TaskEventBody[] {
  const taskId = text(message.task_id);
  if (taskId === undefined) {
    return [];
  }
  switch (message.subtype) {
    case "task_started":
      return [started(message, taskId)];
    case "task_updated":
      return [updated(message, taskId)];
    case "task_progress":
      return typeof message.description === "string" && message.description !== previousDescription
        ? [{ kind: "task_updated", taskId, description: message.description }]
        : [];
    case "task_notification":
      return ended(message, taskId);
    default:
      return [];
  }
}

/** Progress repeats often; remember each task's last reported description across turns. */
export function claudeTaskViews(
  message: JsonRecord,
  descriptions: ReadonlyMap<string, string>,
  agentPath: readonly string[],
): { events: TaskEventBody[]; descriptions: ReadonlyMap<string, string> } {
  const key = JSON.stringify([...agentPath, message.task_id]);
  const events = taskEvents(message, descriptions.get(key));
  const description = events.find((event) => event.kind !== "task_ended" && event.description !== undefined);
  if (description?.kind !== "task_ended" && description?.description !== undefined && description.description !== descriptions.get(key)) {
    return { events, descriptions: new Map([...descriptions, [key, description.description]]) };
  }
  return { events, descriptions };
}
