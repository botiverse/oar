import type { AnswerQuestionOutcome, UserQuestionAnswer } from "./user-questions.js";
import type { RequestRecord, ResponseRecord } from "./records.js";

/**
 * Host-answered runtime→app requests (docs/spec/app-requests.md): two
 * distinct round-trips, not one decision carrying both.
 *
 * - `Session.answer(requestId, AppRequestDecision)` answers an APPROVAL:
 *   may the agent run this action?
 * - `Session.answerQuestion(requestId, AppQuestionAnswers)` answers a
 *   QUESTION: which option or text did the person choose?
 *
 * A runtime→app request is a record with `direction: "toApp"` and the
 * runtime's own id. An adapter that puts such a request under HOST ownership
 * stops answering it itself and exposes the matching method; OAR writes the
 * runtime-native reply, records it as the request's `answered` response with
 * `by: "host"`, and reports what it could observe: a native acknowledgment
 * (`accepted`), none (`unconfirmed`), an expired wait (`timeout`), or a
 * request that no longer waits (`aborted`). A host answer OAR refused is
 * `rejected`; callers still own nothing, because no reply was written.
 *
 * An approval decision never carries answers, and a question answer never
 * grants permission. Each method refuses the other's request kind.
 */

/**
 * What a runtime→app request asks for, read off its `type`: the runtime's
 * native method or subtype. Each runtime names the same ask differently (ACP
 * `session/request_permission`, codex
 * `item/commandExecution/requestApproval`, claude `can_use_tool`); only OAR
 * knows the mapping. The set is OPEN (runtimes add methods), so an
 * unrecognised type is `unknown` rather than force-fit.
 *
 * - `approval`: may the agent go ahead with an action (a tool call, a command, a file change)?
 * - `question`: the agent, or an MCP server through it, asks the user for input.
 * - `service`: a client call the adapter serves itself (an ACP terminal or file); no person is asked.
 * - `unknown`: a type OAR does not recognise; a host keeps showing it.
 */
export type AppRequestKind = "approval" | "question" | "service" | "unknown";

/**
 * A host's decision for ONE host-owned approval request. The vocabulary is
 * runtime-independent: an adapter maps it to the native reply its protocol
 * takes (`behavior: "allow"`, a permission option id, a JSON-RPC decision),
 * and refuses `unsupported` where the protocol cannot express it (for
 * example `scope: "always"` when the runtime offers no lasting option).
 *
 * Questions (`AppRequestKind` "question") and adapter-served requests
 * ("service") are not answers this decision covers; `answer` refuses them.
 */
export type AppRequestDecision =
  /** Go ahead. `scope` asks for this action once (default) or for the same ask in future; an adapter that cannot honor one refuses `unsupported` rather than widening or narrowing it. */
  | { readonly decision: "allow"; readonly scope?: "once" | "always" }
  /** Do not go ahead. `reason` is shown to the agent where the protocol carries a message; otherwise it stays in the record only. */
  | { readonly decision: "deny"; readonly reason?: string };

/**
 * A host's answer to ONE host-owned question request: per question id (the
 * runtime's key, claude's question text), the chosen option label(s) or free
 * text. It answers a question; it is not an approval and grants nothing.
 */
export interface AppQuestionAnswers {
  readonly answers: Readonly<Record<string, string | readonly string[]>>;
}

/**
 * What a host hands `Session.answerQuestion`, in either of the two dialects a
 * host may hold questions in:
 *
 * - `AppQuestionAnswers` (this contract): per question id, the option label(s)
 *   or free text. Selected by `SessionOptions.questions: "ask"`, whose outcome
 *   carries OAR's receipt evidence (`QuestionAnswerOutcome`).
 * - `UserQuestionAnswer` (contracts/user-questions.ts): the same answer, or an
 *   explicit decline. Selected by `SessionOptions.userQuestions: "host"`,
 *   whose outcome is `AnswerQuestionOutcome`.
 *
 * Both dialects are accepted by either option, so a host never has to know
 * which mechanism an adapter was built on; the ANSWER an adapter writes to the
 * runtime is the same one.
 */
export type HostQuestionAnswer = AppQuestionAnswers | UserQuestionAnswer;

/** The outcome a host reads: `QuestionAnswerOutcome` for `questions: "ask"`, `AnswerQuestionOutcome` for `userQuestions: "host"`. */
export type HostQuestionAnswerOutcome = QuestionAnswerOutcome | AnswerQuestionOutcome;

/** Bounds one `Session.answer` / `Session.answerQuestion` call. Neither cancels work the runtime already began. */
export interface AnswerOptions {
  /**
   * Wait at most this many milliseconds for the runtime's own acknowledgment
   * after the reply was written. `0` does not wait. Omitted uses the
   * session's declared `appRequests.acknowledgeTimeoutMs`.
   */
  readonly timeoutMs?: number;
  /**
   * Aborts BEFORE the decision is written: an already-aborted signal refuses
   * the answer (`aborted`, `answer_aborted`) and writes nothing. After
   * dispatch it bounds only the acknowledgment wait, like `timeoutMs`: the
   * wait ends at once and the outcome is `unconfirmed`. OAR never unwrites
   * the reply, never claims the runtime applied it, and never claims native
   * execution stopped.
   */
  readonly signal?: AbortSignal;
}

/** The request a decision answered and, when OAR wrote one, the recorded reply. */
interface AnswerEvidence {
  /** The `toApp` request record the host answered; absent only when no record of this stream carries the id (`unknown_request`). */
  readonly request?: RequestRecord;
  /** The `answered` response record; absent when the answer was refused before anything was written. */
  readonly response?: ResponseRecord;
  /** The request record's position in the stream (`request.seq`), `-1` when no record carries the id. */
  readonly seq: number;
  readonly requestId: string;
}

/**
 * What `Session.answer` observed. `accepted` and `unconfirmed` both mean the
 * approval reply was written and recorded; they differ in whether the
 * runtime's own acknowledgment was seen (`unconfirmed` also covers a caller
 * signal that ended the wait). `timeout` means the reply was written but no
 * acknowledgment arrived within the bound, or that OAR's unanswered-approval
 * policy answered in the host's place (`code: "unanswered"`). `aborted` means
 * the request stopped waiting before this answer took ownership. `rejected`
 * means OAR did not write anything.
 */
export type AnswerOutcome = AnswerEvidence & (
  | { readonly kind: "accepted"; readonly decision: AppRequestDecision; readonly native: unknown }
  | { readonly kind: "unconfirmed"; readonly decision: AppRequestDecision; readonly native: unknown }
  | { readonly kind: "rejected"; readonly code: AnswerRejectionCode; readonly reason: string }
  | {
      readonly kind: "timeout";
      /** `no_native_ack`: the reply was written and no acknowledgment arrived. `unanswered`: the session's approval policy decided because no host answered in time. */
      readonly code: "no_native_ack" | "unanswered";
      readonly reason: string;
      readonly decision?: AppRequestDecision;
      readonly native?: unknown;
    }
  | {
      readonly kind: "aborted";
      /** `cancelled`: the runtime withdrew the request. `answer_aborted`: the caller's signal. `disposed`, `runtime_exited`, `session_released`: the session stopped waiting. */
      readonly code: "cancelled" | "answer_aborted" | "disposed" | "runtime_exited" | "session_released";
      readonly reason: string;
    }
);

/**
 * What `Session.answerQuestion` observed. Same evidence and fate as
 * `AnswerOutcome`, but the host's payload is `answers`, never an approval
 * decision. There is no policy answer for a question: `timeout` here only
 * means a written reply's acknowledgment did not arrive.
 */
export type QuestionAnswerOutcome = AnswerEvidence & (
  | { readonly kind: "accepted"; readonly answers: AppQuestionAnswers; readonly native: unknown }
  | { readonly kind: "unconfirmed"; readonly answers: AppQuestionAnswers; readonly native: unknown }
  | { readonly kind: "rejected"; readonly code: AnswerRejectionCode; readonly reason: string }
  | {
      readonly kind: "timeout";
      readonly code: "no_native_ack";
      readonly reason: string;
      readonly answers?: AppQuestionAnswers;
      readonly native?: unknown;
    }
  | {
      readonly kind: "aborted";
      readonly code: "cancelled" | "answer_aborted" | "disposed" | "runtime_exited" | "session_released";
      readonly reason: string;
    }
);

/**
 * Why OAR refused a host answer, as one word a host can branch on. Every
 * rejection leaves the runtime unwritten and the caller owning nothing.
 */
export type AnswerRejectionCode =
  /** No request of this session carries this id: never recorded here, or carried over from a stream that a `resume` replaced. Request ids are native to one stream and never survive a resume. */
  | "unknown_request"
  /** The request exists but this method does not cover it (an approval answer for a question, or vice versa), no host owns it, or the adapter already answered it. */
  | "not_answerable"
  /** The request already has an `answered` response (its own automatic answer, the unanswered policy, or another `answer`). */
  | "already_answered"
  /** Another `answer` for the same request is in flight; this call changed nothing. */
  | "busy"
  /** The runtime's protocol cannot express this decision (for example `scope: "always"` where it offers no lasting option). */
  | "unsupported"
  /** The adapter could not write the reply; `reason` is the transport's message. */
  | "error";

/**
 * Per-session facts a host reads before answering: which asks wait for it,
 * and what OAR does when it does not. Reported as
 * `SessionCapabilities.appRequests`; absent means no request is
 * host-answerable (the adapter answers or records them itself) and
 * `Session.answer` is absent too.
 */
export interface AppRequestAnswering {
  /** The APPROVAL kinds a host owns through `Session.answer`; other kinds keep the adapter's own handling. */
  readonly kinds: readonly AppRequestKind[];
  /** The session exposes `Session.answerQuestion` for question requests. There is no policy answer for a question: an unanswered one stays pending. */
  readonly questions: boolean;
  /**
   * What OAR answers when no host answers an APPROVAL in time. `wait` leaves
   * it pending, which can hold the runtime's turn for as long as it waits; an
   * embedded host that cannot present requests should choose a decision
   * (`deny` is the safe one) and a deadline.
   */
  readonly unanswered: { readonly afterMs: number; readonly decision: AppRequestDecision } | { readonly decision: "wait" };
  /** The default bound for one answer's acknowledgment wait. */
  readonly acknowledgeTimeoutMs: number;
}
