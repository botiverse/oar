import type { ChatCompletionRequest } from "@copilotkit/aimock";
import { asRecord, parseJson } from "../../../packages/oar/src/shared/json.js";

/** Aimock drops agent_message items. Carry this request's recipient into its normalized messages. */
export function codexTaskRequest(body: unknown): unknown {
  const request = asRecord(body);
  if (!Array.isArray(request?.input)) { return body; }
  const input: unknown[] = request.input;
  const recipient = input.map(value => asRecord(value)).findLast(item => item?.type === "agent_message")?.recipient;
  return { ...request, input: [...input, { role: "user", content: JSON.stringify({ oarTaskRecipient: recipient ?? "/root" }) }] };
}

export function codexTaskRecipient(request: ChatCompletionRequest): unknown {
  const content = request.messages.at(-1)?.content;
  return typeof content === "string" ? asRecord(parseJson(content))?.oarTaskRecipient : undefined;
}
