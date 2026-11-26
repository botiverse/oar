import type { AppQuestionAnswers } from "../../contracts/answer.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";

/**
 * claude's question tool over stream-json (2.1.309, probed 2026-11-24 with a
 * scripted provider; experiments/app-request-answering/question-probe.ts):
 * `AskUserQuestion` is a `can_use_tool` control request carrying
 * `input.questions` and `requires_user_interaction: true`. The host answers it
 * with `behavior: "allow"` and the SAME input plus `answers`, keyed by the
 * question text; the model reads the pairs back in the same turn. claude
 * acknowledges no reply, so the recorded outcome stays `unconfirmed`.
 */
const QUESTION_TOOL = "AskUserQuestion";

/** The `can_use_tool` request body when it asks questions, else null. */
export function claudeQuestion(native: unknown): JsonRecord | null {
  const request = asRecord(asRecord(native)?.request);
  if (request?.subtype !== "can_use_tool" || request.tool_name !== QUESTION_TOOL || !Array.isArray(asRecord(request.input)?.questions)) {
    return null;
  }
  return request;
}

/** The native `control_response` carrying the host's answers. */
export function claudeQuestionReply(requestId: string, request: JsonRecord, answers: AppQuestionAnswers): JsonRecord {
  const input = asRecord(request.input) ?? {};
  const normalized = Object.fromEntries(Object.entries(answers.answers).map(([question, value]) => [question, Array.isArray(value) ? value.join(", ") : value]));
  return { type: "control_response", response: { subtype: "success", request_id: requestId, response: { behavior: "allow", updatedInput: { ...input, answers: normalized } } } };
}

/**
 * The reply to a NON-question `can_use_tool` while questions are on: claude's
 * permission gate is the route for questions, so a tool approval that arrives
 * is denied. Never an allow: `Session.answerQuestion` grants nothing.
 */
export function claudeApprovalDeny(requestId: string): JsonRecord {
  return { type: "control_response", response: { subtype: "success", request_id: requestId, response: { behavior: "deny", message: "OAR answers the runtime's questions, not tool approvals." } } };
}
