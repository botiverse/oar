import type { AnswerQuestionOutcome, AnswerQuestionRejectionCode, UserQuestionAnswer, UserQuestionItem, UserQuestionPrompt } from "../contracts/user-questions.js";
import type { SessionKernel } from "./session-kernel.js";

/** A reply as the runtime gets it, and as the stream keeps it (secret answers redacted). */
export interface NativeReply { readonly send: () => void; readonly recorded: unknown }

interface Pending { readonly prompt: UserQuestionPrompt; readonly reply: (answer: UserQuestionAnswer) => NativeReply }

/** Questions a host opted into answering (`SessionOptions.userQuestions`): held without a deadline until answered, withdrawn, or the runtime is gone. */
export interface UserQuestions {
  /** Hold a request whose `toApp` record is already in the stream. */
  readonly hold: (requestId: string, prompt: UserQuestionPrompt, reply: (answer: UserQuestionAnswer) => NativeReply) => void;
  /** The runtime no longer waits; true when the question was still unanswered. */
  readonly withdraw: (requestId: string) => boolean;
  readonly answer: (requestId: string, answer: UserQuestionAnswer) => Promise<AnswerQuestionOutcome>;
}

function itemProblem(item: UserQuestionItem, given: { readonly selected?: readonly string[]; readonly text?: string }): string | null {
  const selected = given.selected ?? [];
  if (selected.length > 1 && !item.multiSelect) { return "takes one selected option"; }
  const labels = new Set((item.options ?? []).map((option) => option.label));
  const unknown = selected.find((label) => !labels.has(label));
  if (unknown !== undefined) { return `has no option ${JSON.stringify(unknown)}; give other words as text`; }
  if (given.text !== undefined && given.text !== "" && !item.allowOther && (item.options?.length ?? 0) > 0) { return "takes only its own options"; }
  return null;
}

function answerProblem(prompt: UserQuestionPrompt, answer: UserQuestionAnswer): string | null {
  if (answer.kind === "declined") { return null; }
  for (const [id, given] of Object.entries(answer.answers)) {
    const item = prompt.questions.find((question) => question.id === id);
    if (item === undefined) { return `the request asks no question ${JSON.stringify(id)}`; }
    const problem = itemProblem(item, given);
    if (problem !== null) { return `question ${JSON.stringify(id)} ${problem}`; }
  }
  return null;
}

export function createUserQuestions(kernel: SessionKernel): UserQuestions {
  const pending = new Map<string, Pending>();
  const resolved = new Set<string>();
  const decide = (requestId: string, answer: UserQuestionAnswer): AnswerQuestionOutcome => {
    const refuse = (code: AnswerQuestionRejectionCode, reason: string): AnswerQuestionOutcome => ({ kind: "rejected", requestId, code, reason });
    const unreachable = kernel.unreachable();
    if (unreachable !== null) {
      pending.clear();
      return refuse(unreachable.code === "runtime_exited" ? "runtime_exited" : "disposed", unreachable.reason);
    }
    const held = pending.get(requestId);
    if (held === undefined) {
      return resolved.has(requestId) ? refuse("already_resolved", "the question was already answered or withdrawn") : refuse("unknown_request", "no question with this request id waits for an answer");
    }
    const problem = answerProblem(held.prompt, answer);
    if (problem !== null) { return refuse("unsupported", problem); }
    try {
      const reply = held.reply(answer);
      reply.send();
      pending.delete(requestId);
      resolved.add(requestId);
      const response = kernel.respond(requestId, { kind: "answered", native: reply.recorded });
      return { kind: "answered", requestId, seq: response.seq, response };
    } catch (error) {
      return refuse("error", error instanceof Error ? error.message : String(error));
    }
  };
  return {
    hold: (requestId, prompt, reply) => { resolved.delete(requestId); pending.set(requestId, { prompt, reply }); },
    withdraw: (requestId) => {
      const open = pending.delete(requestId);
      if (open) { resolved.add(requestId); }
      return open;
    },
    // oxlint-disable-next-line typescript/require-await -- One settled answer; the contract is asynchronous like every control.
    answer: async (requestId, answer) => decide(requestId, answer),
  };
}
