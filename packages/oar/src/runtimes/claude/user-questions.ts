import type { RefusedSessionOptions } from "../../contracts/runtime.js";
import type { UserQuestionAnswer } from "../../contracts/user-questions.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { semverAtLeast } from "../../shared/semver.js";

/** Probed with a scripted provider: 2.1.274 and 2.1.332 ask, take the answer, the decline and the interrupt alike. */
export function claudeUserQuestionRefusal(version?: string): RefusedSessionOptions {
  return semverAtLeast(version, "2.1.274") ? {} : { userQuestions: "Claude user questions need a verified installation of 2.1.274 or later" };
}

/**
 * What makes claude ask OAR. The prompt target also brings in plan mode, which
 * print mode otherwise lacks: entering it needs no approval, leaving it does,
 * and nobody here approves, so a session that entered could never edit again
 * ([env] 2.1.332). The two tools stay out, as without the target.
 */
export const CLAUDE_QUESTION_ARGS: readonly string[] = ["--permission-prompt-tool", "stdio"];
export const CLAUDE_QUESTION_DISALLOWED: readonly string[] = ["EnterPlanMode", "ExitPlanMode"];

function response(requestId: string, body: JsonRecord): JsonRecord {
  return { type: "control_response", response: { subtype: "success", request_id: requestId, response: body } };
}

/** Every permission request that is not a question: OAR answers questions, not approvals. */
export function claudePermissionDenial(requestId: string): JsonRecord {
  return response(requestId, { behavior: "deny", message: "OAR answers questions only; this session has no one to approve a tool." });
}

/** Answers go back inside the tool's input, keyed by the question's text; several choices are one comma-separated string. */
export function claudeQuestionReply(requestId: string, request: JsonRecord, answer: UserQuestionAnswer): JsonRecord {
  if (answer.kind === "declined") { return response(requestId, { behavior: "deny", message: answer.reason ?? "The user declined to answer." }); }
  const answers = Object.fromEntries(Object.entries(answer.answers).flatMap(([id, given]) => {
    const words = [...given.selected ?? [], ...(given.text === undefined || given.text === "" ? [] : [given.text])];
    return words.length === 0 ? [] : [[id, words.join(", ")]];
  }));
  return response(requestId, { behavior: "allow", updatedInput: { ...asRecord(request.input), answers } });
}
