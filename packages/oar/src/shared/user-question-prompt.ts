import type { UserQuestionItem, UserQuestionPrompt } from "../contracts/user-questions.js";
import { asRecord, asRecordList, type JsonRecord } from "./json.js";

const CODEX_QUESTION = "item/tool/requestUserInput";

/** claude asks through its permission request: the tool call is the question. */
export function claudeQuestion(type: string, body: unknown): JsonRecord | null {
  const request = type === "can_use_tool" ? asRecord(asRecord(body)?.request) : null;
  return request?.tool_name === "AskUserQuestion" ? asRecord(request.input) : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function questionItem(question: JsonRecord, id: unknown, own: Pick<UserQuestionItem, "multiSelect" | "allowOther" | "secret">): UserQuestionItem | null {
  const words = text(question.question);
  const key = text(id);
  if (words === undefined || key === undefined) { return null; }
  const header = text(question.header);
  const options = asRecordList(question.options).flatMap((option) => {
    const label = text(option.label);
    const description = text(option.description);
    return label === undefined ? [] : [{ label, ...(description === undefined ? {} : { description }) }];
  });
  return { id: key, question: words, ...(header === undefined ? {} : { header }), ...(options.length === 0 ? {} : { options }), ...own };
}

/**
 * A question to the person in one shape, read off a runtime→app request's
 * native body: codex `item/tool/requestUserInput` (0.172.0) and claude
 * `can_use_tool` for `AskUserQuestion` (2.1.332, whose own UI always takes
 * other words). Null for any other request, and for one with a question it
 * cannot read (a half-read prompt would hide what is asked) or two under one
 * id (answers are keyed by it).
 */
export function userQuestionOf(type: string, body: unknown): UserQuestionPrompt | null {
  const claude = claudeQuestion(type, body);
  const asked = claude ?? (type === CODEX_QUESTION ? asRecord(body) : null);
  if (asked === null) { return null; }
  const questions = asRecordList(asked.questions).map((question) => claude === null
    ? questionItem(question, question.id, { multiSelect: false, allowOther: question.isOther === true || asRecordList(question.options).length === 0, secret: question.isSecret === true })
    : questionItem(question, question.question, { multiSelect: question.multiSelect === true, allowOther: true, secret: false }));
  const read = questions.filter((question) => question !== null);
  const ids = new Set(read.map((question) => question.id));
  return read.length === 0 || read.length !== questions.length || ids.size !== read.length ? null : { questions: read };
}
