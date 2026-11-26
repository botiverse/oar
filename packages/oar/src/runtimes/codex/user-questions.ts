import type { UserQuestionAnswer, UserQuestionPrompt } from "../../contracts/user-questions.js";
import type { RuntimeEventBody } from "../../contracts/session.js";
import { asRecord, parseJson, type JsonRecord } from "../../shared/json.js";
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

/** Scrubbing state for secret `item/tool/requestUserInput` answers echoed in `rawResponseItem/completed`. */
export interface CodexSecretQuestions {
  readonly recordAnswer: (itemId: unknown, prompt: UserQuestionPrompt, answer: UserQuestionAnswer) => void;
  readonly scrubNotification: (method: string, params: JsonRecord) => JsonRecord;
  readonly clear: () => void;
}

function scrubOutputJson(raw: string, secretIds: ReadonlySet<string>): string {
  const parsed = asRecord(parseJson(raw));
  const answers = asRecord(parsed?.answers);
  if (parsed === null || answers === null) { return REDACTED; }
  const nextAnswers = Object.fromEntries(Object.entries(answers).map(([id, entry]) => {
    if (!secretIds.has(id)) { return [id, entry]; }
    const record = asRecord(entry);
    const list = record?.answers;
    return [id, { answers: Array.isArray(list) ? list.map(() => REDACTED) : [REDACTED] }];
  }));
  return JSON.stringify({ answers: nextAnswers });
}

function scrubFunctionCallOutput(output: unknown, secretIds: ReadonlySet<string>): unknown {
  if (typeof output === "string") { return scrubOutputJson(output, secretIds); }
  if (!Array.isArray(output)) { return REDACTED; }
  const parts: JsonRecord[] = [];
  for (const part of output) {
    const record = asRecord(part);
    if (record === null || typeof record.text !== "string") { return REDACTED; }
    parts.push({ ...record, text: scrubOutputJson(record.text, secretIds) });
  }
  return parts;
}

/**
 * Scrub secret `request_user_input` answers from Codex's `rawResponseItem/completed`
 * `function_call_output` echo (emitted on `thread/start` with `experimentalRawEvents`),
 * and add secret free-text answers (never option labels) to the session redactor.
 */
export function createCodexSecretQuestions(rememberSecretText: (value: string | undefined) => void): CodexSecretQuestions {
  const pending = new Map<string, ReadonlySet<string>>();
  return {
    recordAnswer(itemId, prompt, answer) {
      if (answer.kind !== "answered") { return; }
      const secretIds = new Set(prompt.questions.filter((question) => question.secret).map((question) => question.id));
      if (secretIds.size === 0) { return; }
      for (const [id, given] of Object.entries(answer.answers)) {
        if (secretIds.has(id) && given.text !== undefined && given.text !== "") {
          rememberSecretText(given.text);
        }
      }
      if (typeof itemId === "string" && itemId !== "") { pending.set(itemId, secretIds); }
    },
    scrubNotification(method, params) {
      if (method !== "rawResponseItem/completed" || pending.size === 0) { return params; }
      const item = asRecord(params.item);
      if (item === null || item.type !== "function_call_output" || typeof item.call_id !== "string") { return params; }
      const secretIds = pending.get(item.call_id);
      if (secretIds === undefined) { return params; }
      pending.delete(item.call_id);
      return { ...params, item: { ...item, output: scrubFunctionCallOutput(item.output, secretIds) } };
    },
    clear() { pending.clear(); },
  };
}
