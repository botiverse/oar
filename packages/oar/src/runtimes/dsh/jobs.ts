import type { RawEvent, TaskEventBody } from "../../contracts/session.js";
import { asRecord, parseJson, type JsonRecord } from "../../shared/json.js";

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

/** Job registration also covers foreground tools. Read the initiating call before stopping a job. */
export function isBackgroundShellJob(records: readonly RawEvent[], sessionId: string, taskId: string): boolean {
  let toolCall: { id: string; name: string } | null = null;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.kind !== "frame" || record.sessionId !== sessionId || record.agentPath.length > 0) { continue; }
    for (const event of record.body.events) {
      if (event.kind === "task_started" && event.taskId === taskId && event.taskType === "shell" && event.toolCallId !== undefined && event.nativeType !== undefined) {
        toolCall = { id: event.toolCallId, name: event.nativeType };
      } else if (toolCall !== null && event.kind === "tool_call_started" && event.callId === toolCall.id) {
        return event.tool === toolCall.name && typeof event.input === "string" && asRecord(parseJson(event.input))?.run_in_background === true;
      }
    }
  }
  return false;
}
