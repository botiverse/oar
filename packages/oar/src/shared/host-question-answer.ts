import type { AppQuestionAnswers, HostQuestionAnswer } from "../contracts/answer.js";
import type { UserQuestionAnswer } from "../contracts/user-questions.js";

/**
 * The seam between the two answer dialects a host may hand
 * `Session.answerQuestion` (contracts/answer.ts):
 *
 * - `AppQuestionAnswers` is the receipt-evidence dialect: per question id,
 *   the option label(s) or free text.
 * - `UserQuestionAnswer` is the release OAR dialect: the same answer split
 *   into `selected` / `text`, plus an explicit decline.
 *
 * An adapter is built on ONE of them and must not quietly read the other as an
 * empty answer, so each side converts here and refuses what it cannot express.
 */

/** True for the release `userQuestions` dialect (a `kind` discriminant); false for `AppQuestionAnswers`. */
export function isUserQuestionAnswer(answer: HostQuestionAnswer): answer is UserQuestionAnswer {
  return "kind" in answer;
}

/** The words of one question in the release dialect, in the order claude and codex join them. */
function words(given: { readonly selected?: readonly string[]; readonly text?: string }): readonly string[] {
  const selected = given.selected ?? [];
  const text = given.text === undefined || given.text === "" ? [] : [given.text];
  return [...selected, ...text];
}

/**
 * `AppQuestionAnswers` for an adapter built on the receipt-evidence dialect,
 * or the reason it cannot express this answer. An answer the release dialect spells
 * out as a decline is refused: this dialect has no "no", and writing an empty
 * answer instead would report an answer nobody gave. A question answered with
 * both option labels and free text keeps both, joined as the runtimes join them.
 */
export function asAppQuestionAnswers(answer: HostQuestionAnswer): AppQuestionAnswers | string {
  if (!isUserQuestionAnswer(answer)) { return answer; }
  if (answer.kind === "declined") {
    return "this session answers questions with text or option labels and has no decline; leave the question unanswered or dispose the session";
  }
  const answers: Record<string, string | readonly string[]> = {};
  for (const [id, given] of Object.entries(answer.answers)) {
    const said = words(given);
    const [first, ...rest] = said;
    // One word stays a word: a single label is what the runtime joins anyway.
    if (first !== undefined) { answers[id] = rest.length === 0 ? first : [first, ...rest]; }
  }
  return { answers };
}

/**
 * The release `UserQuestionAnswer` for an adapter built on it, from either
 * dialect. `AppQuestionAnswers` has no decline, and a bare string there is
 * free text (a label the runtime offered or words the person typed), which is
 * the release dialect's `text`.
 */
export function asUserQuestionAnswer(answer: HostQuestionAnswer): UserQuestionAnswer {
  if (isUserQuestionAnswer(answer)) { return answer; }
  const answers: Record<string, { readonly selected?: readonly string[]; readonly text?: string }> = {};
  for (const [id, given] of Object.entries(answer.answers)) {
    answers[id] = typeof given === "string" ? { text: given } : { selected: given };
  }
  return { kind: "answered", answers };
}
