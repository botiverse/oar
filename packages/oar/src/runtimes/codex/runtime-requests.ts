import { userQuestionOf } from "../../shared/user-question-prompt.js";
import type { SessionKernel } from "../../shared/session-kernel.js";
import type { JsonRecord } from "../../shared/json.js";
import type { NativeReply, UserQuestions } from "../../shared/user-questions.js";
import type { AppServerClient } from "./app-server-client.js";
import { CODEX_QUESTION_METHOD, codexQuestionReply } from "./user-questions.js";

const declined = "OAR has no way to answer this request";

/**
 * Each decision request's own "no", from the app-server schema. Only a
 * question can be answered by a host, and only when it opted in
 * (SessionOptions.userQuestions); any other request left open would hang the turn.
 */
const nativeRefusals = new Map<string, JsonRecord>([
  ["item/commandExecution/requestApproval", { decision: "decline" }],
  ["item/fileChange/requestApproval", { decision: "decline" }],
  ["item/permissions/requestApproval", { permissions: {} }],
  ["item/tool/requestUserInput", { answers: {} }],
  ["item/tool/call", { contentItems: [{ type: "inputText", text: declined }], success: false }],
  ["mcpServer/elicitation/request", { action: "decline" }],
  ["applyPatchApproval", { decision: "denied" }],
  ["execCommandApproval", { decision: "denied" }],
]);

/** The reply to a request codex sent: its native refusal, or `method not found` for anything that is not a decision. */
export function codexRequestReply(method: string): { readonly result: JsonRecord } | { readonly error: { readonly code: number; readonly message: string } } {
  const result = nativeRefusals.get(method);
  return result === undefined ? { error: { code: -32_601, message: `${declined}: ${method}` } } : { result };
}

/** Record a request codex sent, verbatim, then answer it and record the answer; a question the host answers stays open instead. */
export function codexServerRequests(kernel: SessionKernel, client: AppServerClient, questions?: UserQuestions) {
  return (id: string, method: string, params: JsonRecord): void => {
    kernel.request("toApp", { kind: "native", type: method, native: params }, { id });
    const prompt = questions === undefined || method !== CODEX_QUESTION_METHOD ? null : userQuestionOf(method, params);
    if (questions !== undefined && prompt !== null) {
      questions.hold(id, prompt, (answer): NativeReply => ({ send: () => { client.respond(id, codexQuestionReply(prompt, answer)); }, recorded: codexQuestionReply(prompt, answer, true) }));
      return;
    }
    const reply = codexRequestReply(method);
    client.respond(id, reply);
    kernel.respond(id, { kind: "answered", native: reply });
  };
}
