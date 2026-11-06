import type { TaskEventBody } from "../../contracts/session.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";

/** Durable DSH job facts, without mistaking a completed tool call for a completed job. */
export function dshJobEvents(type: string, data: JsonRecord, sessionId: string): readonly TaskEventBody[] {
  // Copied history keeps the original owner; it does not transfer a live job.
  if (typeof data.jobId !== "string" || data.owner !== sessionId) { return []; }
  if (type === "job/registered") {
    const callId = asRecord(data.toolCall)?.callId;
    return [{ kind: "task_started", taskId: data.jobId,
      taskType: data.kind === "bash" || data.kind === "pwsh" ? "shell" : "other",
      ...(typeof data.kind === "string" ? { nativeType: data.kind } : {}),
      ...(typeof data.label === "string" ? { description: data.label } : {}),
      ...(typeof callId === "string" ? { toolCallId: callId } : {}) }];
  }
  if (type !== "job/settled") { return []; }
  const status = data.status === "completed" || data.status === "failed" ? data.status : (data.status === "killed" ? "stopped" : undefined);
  if (status === undefined) { return []; }
  return [{ kind: "task_ended", taskId: data.jobId, status,
    ...(typeof data.detail === "string" ? { summary: data.detail } : {}) }];
}
