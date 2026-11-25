import type { AppRequestAnswering, AppRequestDecision, AppRequestKind, AnswerOptions, AnswerOutcome } from "../contracts/answer.js";
import type { RawEvent, RequestRecord, ResponseRecord } from "../contracts/records.js";
import { appRequestKind } from "../observe/app-requests.js";
import { answerAborted, answerRefusal, correlation, ignoreLateReceipt } from "./app-request-outcome.js";
import type { RecordAt, SessionKernel } from "./session-kernel.js";

/**
 * The reusable host-answered approval round-trip (docs/spec/app-requests.md):
 * the adapter supplies the native reply and says whether its protocol
 * acknowledges one; everything else — correlation by request record id, one
 * answer per request, the unanswered policy, teardown settlement, the
 * recorded `answered` response with `by: "host"`, and the outcome vocabulary —
 * is shared here and never re-implemented per runtime.
 *
 * Ownership is explicit: `request` waits for the host and `autoAnswer` takes
 * the request back; a request recorded with `kernel.request`/`kernel.respond`
 * is never registered, so `answer` reports `unknown_request` rather than
 * guessing ownership.
 */
export interface AppRequestAnsweringOptions {
  readonly kernel: SessionKernel;
  /** Which asks a host owns; default `["approval"]`. Others are registered but `answer` refuses them (`not_answerable`). */
  readonly kinds?: readonly AppRequestKind[];
  /** What OAR answers when no host answers in time; default `{decision: "wait"}`. */
  readonly unanswered?: AppRequestAnswering["unanswered"];
  /** Default bound for one answer's acknowledgment wait; `0` (default) does not wait. */
  readonly acknowledgeTimeoutMs?: number;
  /**
   * Write the host's decision to the runtime. `reply` is recorded verbatim as
   * the `answered` response. `acknowledged` resolves when the protocol's own
   * receipt arrives (a JSON-RPC response, a resolved request promise); absent
   * means the protocol has none, so the outcome is `unconfirmed`.
   */
  readonly deliver: (request: RequestRecord, decision: AppRequestDecision) => AppRequestDelivery | Promise<AppRequestDelivery>;
  /** Observe every settled request once. A synchronous callback; its errors never touch the run. */
  readonly onSettled?: (outcome: AnswerOutcome) => void;
}

/** What `deliver` produced: the runtime-native reply, and the protocol's receipt when it has one. */
export interface AppRequestDelivery {
  readonly reply: unknown;
  readonly acknowledged?: Promise<unknown>;
}

export interface AppRequestAnswers {
  /** What `SessionCapabilities.appRequests` reports. */
  readonly capability: AppRequestAnswering;
  /** Record a runtime→app request under the runtime's own id and let the host own it. */
  request(id: string, type: string, native: unknown, at?: RecordAt): RequestRecord;
  /** Answer one host-owned request, or refuse without writing anything. */
  answer(requestId: string, decision: AppRequestDecision, options?: AnswerOptions): Promise<AnswerOutcome>;
  /** Record the adapter's own reply and take the request back from host ownership. */
  autoAnswer(requestId: string, reply: unknown, at?: RecordAt): ResponseRecord;
  /** Stop waiting for answers; pending requests settle `aborted`. Called by the adapter, idempotent. */
  close(reason: "runtime_exited" | "disposed" | "session_released", detail?: string): void;
  /** Request ids still waiting for a host, in registration order. */
  pending(): readonly string[];
}

interface Pending {
  readonly record: RequestRecord;
  readonly type: string;
  readonly kind: AppRequestKind;
  /** An answer or the policy is writing the reply right now. */
  answering: boolean;
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

function safely(observer: ((outcome: AnswerOutcome) => void) | undefined, outcome: AnswerOutcome): void {
  if (observer === undefined) {
    return;
  }
  try {
    observer(outcome);
  } catch {
    // The observer is a side-tap; its failure must not change the answer or the run.
  }
}

/** Build the host-answer machinery for one session: the kernel keeps the records, this keeps which requests wait and their timers. */
export function createAppRequestAnswers(options: AppRequestAnsweringOptions): AppRequestAnswers {
  const { kernel, deliver, onSettled } = options;
  const kinds: readonly AppRequestKind[] = options.kinds ?? ["approval"];
  const unanswered = options.unanswered ?? { decision: "wait" };
  const acknowledgeTimeoutMs = options.acknowledgeTimeoutMs ?? 0;
  const capability: AppRequestAnswering = { kinds, questions: false, unanswered, acknowledgeTimeoutMs };
  const waiting = new Map<string, Pending>();
  const settled = new Map<string, AnswerOutcome>(); // terminal outcomes, so a late answer learns why it stopped waiting

  const settle = (pending: Pending, outcome: AnswerOutcome): AnswerOutcome => {
    if (pending.settled) {
      return outcome;
    }
    pending.settled = true;
    pending.answering = false;
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
    waiting.delete(pending.record.id);
    settled.set(pending.record.id, outcome);
    safely(onSettled, outcome);
    return outcome;
  };

  const recordOf = (requestId: string): RequestRecord | undefined =>
    kernel.records().find((record): record is RequestRecord => record.kind === "request" && record.direction === "toApp" && record.id === requestId);
  const responseOf = (requestId: string): ResponseRecord | undefined =>
    kernel.records().find((record): record is ResponseRecord => record.kind === "response" && record.requestId === requestId && record.body.kind === "answered");

  const answerable = (pending: Pending): boolean => kinds.includes(pending.kind);
  const settleAll = (code: "disposed" | "runtime_exited" | "session_released", reason: string): void => {
    for (const pending of waiting.values()) {
      settle(pending, answerAborted(pending.record, code, reason));
    }
  };

  // Native withdrawal and teardown are facts on the stream; read them there.
  const stopWatching = kernel.rawEvents((record: RawEvent) => {
    if (record.kind === "frame") {
      for (const event of record.body.events) {
        if (event.kind === "app_request_cancelled") {
          const pending = waiting.get(event.requestId);
          if (pending !== undefined) {
            settle(pending, answerAborted(pending.record, "cancelled", "the runtime withdrew the request"));
          }
        }
      }
      return;
    }
    if (record.kind === "response") {
      if (record.body.kind === "exited") {
        settleAll("runtime_exited", "the runtime process exited");
      } else if (record.body.kind === "released") {
        settleAll("session_released", record.body.reason === "abort_fallback" ? "OAR released the session after an aborted turn" : "OAR released the session");
      }
      return;
    }
    if (record.direction === "toRuntime" && record.body.kind === "dispose") {
      settleAll("disposed", "the session was disposed");
    }
  });

  const policyOutcome = (pending: Pending, response: ResponseRecord | undefined, reason: string, native?: unknown): AnswerOutcome => ({
    ...correlation(pending.record.id, pending.record, response),
    kind: "timeout",
    code: "unanswered",
    reason,
    ...(unanswered.decision === "wait" ? {} : { decision: unanswered.decision }),
    ...(response === undefined ? {} : { native }),
  });

  const applyPolicy = async (pending: Pending, afterMs: number, policy: AppRequestDecision): Promise<void> => {
    // A host answer at the deadline owns the request; never write twice.
    if (pending.settled || pending.answering || !answerable(pending)) {
      return;
    }
    pending.answering = true;
    try {
      const delivery = await deliver(pending.record, policy);
      const response = kernel.respond(pending.record.id, { kind: "answered", native: delivery.reply });
      settle(pending, policyOutcome(pending, response, `no host answered within ${String(afterMs)} ms; OAR answered by policy`, delivery.reply));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      settle(pending, policyOutcome(pending, undefined, `no host answered within ${String(afterMs)} ms and the policy reply could not be written: ${detail}`));
    }
  };

  const request: AppRequestAnswers["request"] = (id, type, native, at) => {
    const record = kernel.request("toApp", { kind: "native", type, native }, at === undefined ? { id } : { ...at, id });
    const pending: Pending = { record, type, kind: appRequestKind(type), answering: false, settled: false, timer: undefined };
    waiting.set(id, pending);
    if (answerable(pending) && unanswered.decision !== "wait") {
      const policy = unanswered;
      pending.timer = setTimeout(() => { void applyPolicy(pending, policy.afterMs, policy.decision); }, policy.afterMs);
    }
    return record;
  };

  const autoAnswer: AppRequestAnswers["autoAnswer"] = (requestId, reply, at) => {
    const response = kernel.respond(requestId, { kind: "answered", native: reply }, at);
    const pending = waiting.get(requestId);
    if (pending !== undefined) {
      pending.settled = true;
      pending.answering = false;
      if (pending.timer !== undefined) { clearTimeout(pending.timer); }
      waiting.delete(requestId);
    }
    return response;
  };

  const waitingFor = (requestId: string): AnswerOutcome => {
    const ended = settled.get(requestId);
    if (ended !== undefined) {
      return ended.kind === "accepted" || ended.kind === "unconfirmed"
        ? answerRefusal(requestId, "already_answered", "this request already has an answered response", ended.request, ended.response)
        : ended;
    }
    const requestRecord = recordOf(requestId);
    const response = responseOf(requestId);
    if (response !== undefined) {
      return answerRefusal(requestId, "already_answered", "this request already has an answered response", requestRecord, response);
    }
    return requestRecord === undefined
      ? answerRefusal(requestId, "unknown_request", "no toApp request with this id is in this stream; request ids do not survive a resume")
      : answerRefusal(requestId, "not_answerable", "this request is not waiting for a host answer", requestRecord);
  };

  const acknowledge = async (pending: Pending, decision: AppRequestDecision, reply: unknown, response: ResponseRecord, acknowledged: Promise<unknown> | undefined, bound: number, signal: AbortSignal | undefined): Promise<AnswerOutcome> => {
    const base = correlation(pending.record.id, pending.record, response);
    const unconfirmed = { ...base, kind: "unconfirmed" as const, decision, native: reply };
    // No receipt to wait for, no bound, or the caller already stopped waiting:
    // the reply stays written; OAR claims nothing about the runtime applying it.
    if (acknowledged === undefined || bound <= 0 || signal?.aborted === true) {
      ignoreLateReceipt(acknowledged);
      return settle(pending, unconfirmed);
    }
    const finish = Promise.withResolvers<"timeout" | "aborted">();
    const handle = setTimeout(() => { finish.resolve("timeout"); }, bound);
    const onAbort = (): void => { finish.resolve("aborted"); };
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
      const raced = await Promise.race([receipt, finish.promise]);
      if (raced === "ack") {
        return settle(pending, { ...base, kind: "accepted", decision, native: reply });
      }
      // "aborted": the caller's signal ends only this wait; never unwrite the reply.
      return raced === "aborted"
        ? settle(pending, unconfirmed)
        : settle(pending, { ...base, kind: "timeout", code: "no_native_ack", reason: `the runtime did not acknowledge within ${String(bound)} ms`, decision, native: reply });
    } finally {
      clearTimeout(handle);
      signal?.removeEventListener("abort", onAbort);
    }
  };

  const answer: AppRequestAnswers["answer"] = async (requestId, decision, answerOptions = {}) => {
    const pending = waiting.get(requestId);
    if (pending === undefined) {
      return waitingFor(requestId);
    }
    if (!answerable(pending)) {
      return answerRefusal(requestId, "not_answerable", `this adapter does not hand ${pending.kind} requests to a host`, pending.record);
    }
    const unreachable = kernel.unreachable();
    if (unreachable !== null) {
      const code = unreachable.code === "disposed" ? "disposed" : (unreachable.code === "session_released" ? "session_released" : "runtime_exited");
      return settle(pending, answerAborted(pending.record, code, unreachable.reason));
    }
    if (answerOptions.signal?.aborted === true) {
      return settle(pending, answerAborted(pending.record, "answer_aborted", "the caller's signal was already aborted"));
    }
    if (pending.answering) {
      return answerRefusal(requestId, "busy", "another answer for this request is in flight", pending.record);
    }
    pending.answering = true;
    try {
      const delivery = await deliver(pending.record, decision);
      const response = kernel.respond(requestId, { kind: "answered", native: delivery.reply, by: "host" });
      return await acknowledge(pending, decision, delivery.reply, response, delivery.acknowledged, answerOptions.timeoutMs ?? acknowledgeTimeoutMs, answerOptions.signal);
    } catch (error) {
      pending.answering = false;
      return answerRefusal(requestId, "error", error instanceof Error ? error.message : String(error), pending.record);
    }
  };

  return {
    capability,
    request,
    answer,
    autoAnswer,
    close(reason, detail = "OAR closed host-answered requests") {
      stopWatching();
      for (const pending of waiting.values()) {
        settle(pending, answerAborted(pending.record, reason, detail));
      }
    },
    pending: () => [...waiting.keys()],
  };
}
