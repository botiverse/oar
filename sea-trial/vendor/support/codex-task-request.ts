import type { ChatCompletionRequest } from "@copilotkit/aimock";
import { asRecord, parseJson } from "../../../packages/oar/src/shared/json.js";

/** Aimock drops agent_message items. Carry this request's recipient into its normalized messages. */
export function codexTaskRequest(body: unknown): unknown {
  const request = asRecord(body);
  if (!Array.isArray(request?.input)) { return body; }
  const input: unknown[] = request.input;
  const message = input.map(value => asRecord(value)).findLast(item => item?.type === "agent_message");
  // This fixture's aimock provider echoes task text in encrypted_content; no real ciphertext is decoded.
  const parts: unknown[] = Array.isArray(message?.content) ? message.content : [];
  const taskText = parts.map(value => { const part = asRecord(value); const text = part?.text ?? part?.encrypted_content; return typeof text === "string" ? text : ""; }).join("\n");
  return { ...request, input: [...input, { role: "user", content: JSON.stringify({ oarTaskRecipient: message?.recipient ?? "/root", oarTaskText: taskText }) }] };
}

export function codexTaskRecipient(request: ChatCompletionRequest): unknown {
  const content = request.messages.at(-1)?.content;
  return typeof content === "string" ? asRecord(parseJson(content))?.oarTaskRecipient : undefined;
}

export function codexTaskIsResumed(request: ChatCompletionRequest): boolean {
  const content = request.messages.at(-1)?.content;
  const taskText = typeof content === "string" ? asRecord(parseJson(content))?.oarTaskText : undefined;
  return typeof taskText === "string" && taskText.includes("TASK_CHILD_A_RESUME");
}
