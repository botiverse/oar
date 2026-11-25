import type { UserQuestionAnswer, UserQuestionPrompt } from "../../contracts/user-questions.js";
import type { RuntimeEventBody } from "../../contracts/session.js";
import type { JsonRecord } from "../../shared/json.js";
import type { UserQuestions } from "../../shared/user-questions.js";
import { semverAtLeast } from "../../shared/semver.js";
import type { RefusedSessionOptions } from "../../contracts/runtime.js";

/** The server request a codex question is. */
export const CODEX_QUESTION_METHOD = "item/tool/requestUserInput";
/** Off by default ("under development"): outside plan mode the tool otherwise answers `request_user_input is unavailable in Default mode`. */
export const CODEX_QUESTION_CONFIG = { "features.default_mode_request_user_input": "true" } as const;

/**
 * [env] 0.105.0 ignores the feature; 0.106.0 asks but never sends
 * `serverRequest/resolved`, so a withdrawn question would stay open in the
 * stream; 0.107.0, 0.111.0, 0.118.0, 0.145.0 and 0.172.0 do both.
 */
export function codexUserQuestionRefusal(version?: string): RefusedSessionOptions {
  return semverAtLeast(version, "0.107.0") ? {} : { userQuestions: "Codex user questions need a verified installation of 0.107.0 or later" };
}

const REDACTED = "[redacted]";

/** codex's reply shape; free text is marked `user_note: ` as its own TUI marks it. No answers is its "no". */
export function codexQuestionReply(prompt: UserQuestionPrompt, answer: UserQuestionAnswer, recorded = false): { readonly result: { readonly answers: Readonly<Record<string, { readonly answers: readonly string[] }>> } } {
  if (answer.kind === "declined") { return { result: { answers: {} } }; }
  return { result: { answers: Object.fromEntries(Object.entries(answer.answers).map(([id, given]) => {
    const secret = recorded && prompt.questions.some((question) => question.id === id && question.secret);
    const words = [...given.selected ?? [], ...(given.text === undefined || given.text === "" ? [] : [`user_note: ${given.text}`])];
    return [id, { answers: secret ? words.map(() => REDACTED) : words }];
  })) } };
}

/** `serverRequest/resolved` for a question nobody answered. Every other request is answered as it arrives, so it withdraws nothing. */
export function codexQuestionWithdrawn(questions: UserQuestions | undefined, method: string, params: JsonRecord): readonly RuntimeEventBody[] {
  if (method !== "serverRequest/resolved" || questions === undefined) { return []; }
  if (typeof params.requestId !== "string" && typeof params.requestId !== "number") { return []; }
  const requestId = String(params.requestId);
  return questions.withdraw(requestId) ? [{ kind: "app_request_cancelled", requestId }] : [];
}
