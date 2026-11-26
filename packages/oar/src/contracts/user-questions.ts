import type { ResponseRecord } from "./records.js";

/** One thing a runtime asks the person, read off its native request (`userQuestionOf`). */
export interface UserQuestionItem {
  /** Keys the answer. The runtime's own id; claude gives none, so its question text. */
  readonly id: string;
  readonly question: string;
  readonly header?: string;
  /** Choices the runtime offers; absent for a purely free-form question. */
  readonly options?: readonly { readonly label: string; readonly description?: string }[];
  /** More than one option may be selected. */
  readonly multiSelect: boolean;
  /** Free text is an answer too. */
  readonly allowOther: boolean;
  /** The answer is sensitive: OAR sends it to the runtime and records it redacted. */
  readonly secret: boolean;
}

export interface UserQuestionPrompt {
  readonly questions: readonly UserQuestionItem[];
}

/** `answers` is keyed by `UserQuestionItem.id`; `selected` holds option labels. A question left out stays unanswered. */
export type UserQuestionAnswer =
  | { readonly kind: "answered"; readonly answers: Readonly<Record<string, { readonly selected?: readonly string[]; readonly text?: string }>> }
  | { readonly kind: "declined"; readonly reason?: string };

export type AnswerQuestionRejectionCode = "unknown_request" | "already_resolved" | "unsupported" | "runtime_exited" | "disposed" | "error";

/** `answered`: the native reply was written and `response` records it. `rejected`: nothing was written to the runtime or the stream. */
export type AnswerQuestionOutcome =
  | { readonly kind: "answered"; readonly requestId: string; readonly seq: number; readonly response: ResponseRecord }
  | { readonly kind: "rejected"; readonly requestId: string; readonly code: AnswerQuestionRejectionCode; readonly reason: string };

export interface UserQuestionControl {
  /**
   * Answer, or decline, a question the runtime asked: an unanswered `toApp`
   * request that `appRequestKind` calls `question` and `userQuestionOf` reads.
   * Present only with `SessionOptions.userQuestions: "host"`. A question waits
   * until answered, withdrawn by the runtime (`app_request_cancelled`) or the
   * runtime is gone.
   */
  answerQuestion?(requestId: string, answer: UserQuestionAnswer): Promise<AnswerQuestionOutcome>;
}
