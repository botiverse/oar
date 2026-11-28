import type { RuntimeEventBody } from "../../contracts/session.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";

/** Grok 1.0.77 reports task lifecycle and accepted steer echoes on the parent's extension stream. */
export function grokTaskViews(method: string, params: JsonRecord): RuntimeEventBody[] {
  if (method === "_x.ai/session/interjection") {
    const input = params.text;
    const inputId = params.interjectionId;
    if (typeof input !== "string" && (typeof inputId !== "string" || inputId === "")) { return []; }
    return [{
      kind: "user_message",
      input: typeof input === "string" ? input : "",
      ...(typeof inputId === "string" && inputId !== "" ? { inputId, nativeMessageId: inputId } : {}),
      evidence: "acknowledged",
    }];
  }
  if (method !== "_x.ai/session_notification") { return []; }
  const update = asRecord(params.update);
  const taskId = update?.subagent_id;
  if (update === null || typeof taskId !== "string" || taskId === "") { return []; }
  if (update.sessionUpdate === "subagent_spawned") {
    return [{ kind: "task_started", taskId, taskType: "agent",
      ...(typeof update.model === "string" && update.model.length > 0 ? { model: update.model } : {}),
      ...(typeof update.subagent_type === "string" ? { nativeType: update.subagent_type } : {}),
      ...(typeof update.description === "string" ? { description: update.description } : {}),
      ...(typeof update.child_session_id === "string" ? { childSessionId: update.child_session_id } : {}),
    }];
  }
  if (update.sessionUpdate === "subagent_finished" && (update.status === "completed" || update.status === "failed" || update.status === "stopped")) {
    return [{ kind: "task_ended", taskId, status: update.status,
      ...(typeof update.output === "string" ? { output: update.output } : {}) }];
  }
  return [];
}
