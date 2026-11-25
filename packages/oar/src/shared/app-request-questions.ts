import type { AppQuestionAnswers, AppRequestAnswering, AnswerOptions, QuestionAnswerOutcome } from "../contracts/answer.js";
import type { RawEvent, RequestRecord, ResponseRecord } from "../contracts/records.js";
import { correlation, ignoreLateReceipt, questionAborted, questionRefusal } from "./app-request-outcome.js";
import type { RecordAt, SessionKernel } from "./session-kernel.js";

/**
 * The host-answered QUESTION round-trip (docs/spec/app-requests.md), on the
 * same kernel records and outcome vocabulary as the approval coordinator
 * (`app-request-answers.ts`) but a separate payload and method: a question
 * answer never grants permission, and an approval decision never carries
 * answers. The adapter supplies the native reply; OAR records the request
 * under the runtime's own id, writes `answered` with `by: "host"`, and
 * reports what it observed. There is no policy answer for a question: an
 * unanswered one stays pending.
 */
export interface QuestionAnsweringOptions {
  readonly kernel: SessionKernel;
  /** The default bound for one answer's acknowledgment wait; `0` (default) does not wait. */
  readonly acknowledgeTimeoutMs?: number;
  /** Write the host's answers to the runtime. `reply` is recorded verbatim as the `answered` response. */
  readonly deliver: (request: RequestRecord, answers: AppQuestionAnswers) => QuestionDelivery | Promise<QuestionDelivery>;
  /** Observe every settled request once. A synchronous callback; its errors never touch the run. */
  readonly onSettled?: (outcome: QuestionAnswerOutcome) => void;
}

export interface QuestionDelivery {
  readonly reply: unknown;
  readonly acknowledged?: Promise<unknown>;
}

export interface QuestionAnswers {
  /** What `SessionCapabilities.appRequests` reports. */
  readonly capability: AppRequestAnswering;
  /** Record a runtime→app question under the runtime's own id and let the host own it. */
  request(id: string, type: string, native: unknown, at?: RecordAt): RequestRecord;
  /** Answer one host-owned question request, or refuse without writing anything. */
  answer(requestId: string, answers: AppQuestionAnswers, options?: AnswerOptions): Promise<QuestionAnswerOutcome>;
  /** Stop waiting; pending questions settle `aborted`. Called by the adapter, idempotent. */
  close(reason: "runtime_exited" | "disposed" | "session_released", detail?: string): void;
  /** Request ids still waiting for a host, in registration order. */
  pending(): readonly string[];
}

interface Pending {
  readonly record: RequestRecord;
  answering: boolean;
  settled: boolean;
}

function safely(observer: ((outcome: QuestionAnswerOutcome) => void) | undefined, outcome: QuestionAnswerOutcome): void {
  if (observer === undefined) {
    return;
  }
  try {
    observer(outcome);
  } catch {
    // The observer is a side-tap; its failure must not change the answer or the run.
  }
}

/** Build the question-answer machinery for one session. */
export function createQuestionAnswers(options: QuestionAnsweringOptions): QuestionAnswers {
  const { kernel, deliver, onSettled } = options;
  const bound = options.acknowledgeTimeoutMs ?? 0;
  const capability: AppRequestAnswering = { kinds: [], questions: true, unanswered: { decision: "wait" }, acknowledgeTimeoutMs: bound };
  const waiting = new Map<string, Pending>();
  const settled = new Map<string, QuestionAnswerOutcome>();

  const finish = (pending: Pending, outcome: QuestionAnswerOutcome): QuestionAnswerOutcome => {
    if (pending.settled) {
      return outcome;
    }
    pending.settled = true;
    pending.answering = false;
    waiting.delete(pending.record.id);
    settled.set(pending.record.id, outcome);
    safely(onSettled, outcome);
    return outcome;
  };

  const requestOf = (requestId: string): RequestRecord | undefined =>
    kernel.records().find((record): record is RequestRecord => record.kind === "request" && record.direction === "toApp" && record.id === requestId);
  const responseOf = (requestId: string): ResponseRecord | undefined =>
    kernel.records().find((record): record is ResponseRecord => record.kind === "response" && record.requestId === requestId && record.body.kind === "answered");

  const waitingFor = (requestId: string): QuestionAnswerOutcome => {
    const ended = settled.get(requestId);
    if (ended !== undefined) {
      return ended.kind === "accepted" || ended.kind === "unconfirmed"
        ? questionRefusal(requestId, "already_answered", "this request already has an answered response", ended.request, ended.response)
        : ended;
    }
    const request = requestOf(requestId);
    const response = responseOf(requestId);
    if (response !== undefined) {
      return questionRefusal(requestId, "already_answered", "this request already has an answered response", request, response);
    }
    return request === undefined
      ? questionRefusal(requestId, "unknown_request", "no toApp request with this id is in this stream; request ids do not survive a resume")
      : questionRefusal(requestId, "not_answerable", "this request is not waiting for a host question answer", request);
  };

  const closeAll = (code: "disposed" | "runtime_exited" | "session_released", reason: string): void => {
    for (const pending of waiting.values()) {
      finish(pending, questionAborted(pending.record, code, reason));
    }
  };

  // Native withdrawal and teardown are facts on the stream; read them there.
  const stopWatching = kernel.rawEvents((record: RawEvent) => {
    if (record.kind === "frame") {
      for (const event of record.body.events) {
        if (event.kind === "app_request_cancelled") {
          const pending = waiting.get(event.requestId);
          if (pending !== undefined) {
            finish(pending, questionAborted(pending.record, "cancelled", "the runtime withdrew the request"));
          }
        }
      }
      return;
    }
    if (record.kind === "response") {
      if (record.body.kind === "exited") {
        closeAll("runtime_exited", "the runtime process exited");
      } else if (record.body.kind === "released") {
        closeAll("session_released", "OAR released the session");
      }
      return;
    }
    if (record.direction === "toRuntime" && record.body.kind === "dispose") {
      closeAll("disposed", "the session was disposed");
    }
  });

  const request: QuestionAnswers["request"] = (id, type, native, at) => {
    const record = kernel.request("toApp", { kind: "native", type, native }, at === undefined ? { id } : { ...at, id });
    waiting.set(id, { record, answering: false, settled: false });
    return record;
  };

  const acknowledge = async (pending: Pending, answers: AppQuestionAnswers, reply: unknown, response: ResponseRecord, acknowledged: Promise<unknown> | undefined, timeout: number, signal: AbortSignal | undefined): Promise<QuestionAnswerOutcome> => {
    const base = correlation(pending.record.id, pending.record, response);
    if (acknowledged === undefined || timeout <= 0 || signal?.aborted === true) {
      ignoreLateReceipt(acknowledged);
      return finish(pending, { ...base, kind: "unconfirmed", answers, native: reply });
    }
    const finishTimer = Promise.withResolvers<"timeout" | "aborted">();
    const handle = setTimeout(() => { finishTimer.resolve("timeout"); }, timeout);
    const onAbort = (): void => { finishTimer.resolve("aborted"); };
    signal?.addEventListener("abort", onAbort, { once: true });
    const receipt = (async (): Promise<"ack" | "unobserved"> => {
      try {
        await acknowledged;
        return "ack";
      } catch {
        return "unobserved";
      }
    })();
    try {
      const raced = await Promise.race([receipt, finishTimer.promise]);
      if (raced === "ack") {
        return finish(pending, { ...base, kind: "accepted", answers, native: reply });
      }
      return raced === "aborted"
        ? finish(pending, { ...base, kind: "unconfirmed", answers, native: reply })
        : finish(pending, { ...base, kind: "timeout", code: "no_native_ack", reason: `the runtime did not acknowledge within ${String(timeout)} ms`, answers, native: reply });
    } finally {
      clearTimeout(handle);
      signal?.removeEventListener("abort", onAbort);
    }
  };

  const answer: QuestionAnswers["answer"] = async (requestId, answers, answerOptions = {}) => {
    const pending = waiting.get(requestId);
    if (pending === undefined) {
      return waitingFor(requestId);
    }
    const unreachable = kernel.unreachable();
    if (unreachable !== null) {
      const code = unreachable.code === "disposed" ? "disposed" : (unreachable.code === "session_released" ? "session_released" : "runtime_exited");
      return finish(pending, questionAborted(pending.record, code, unreachable.reason));
    }
    if (answerOptions.signal?.aborted === true) {
      return finish(pending, questionAborted(pending.record, "answer_aborted", "the caller's signal was already aborted"));
    }
    if (pending.answering) {
      return questionRefusal(requestId, "busy", "another answer for this request is in flight", pending.record);
    }
    pending.answering = true;
    try {
      const delivery = await deliver(pending.record, answers);
      const response = kernel.respond(requestId, { kind: "answered", native: delivery.reply, by: "host" });
      return await acknowledge(pending, answers, delivery.reply, response, delivery.acknowledged, answerOptions.timeoutMs ?? bound, answerOptions.signal);
    } catch (error) {
      pending.answering = false;
      return questionRefusal(requestId, "error", error instanceof Error ? error.message : String(error), pending.record);
    }
  };

  return {
    capability,
    request,
    answer,
    close(reason, detail = "OAR closed host-answered questions") {
      stopWatching();
      closeAll(reason, detail);
    },
    pending: () => [...waiting.keys()],
  };
}
