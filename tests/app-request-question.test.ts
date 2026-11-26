/* oxlint-disable eslint/max-statements, eslint/max-lines-per-function -- one contract case per documented outcome; grouping keeps the round-trip readable. */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { AppQuestionAnswers, QuestionAnswerOutcome } from "../packages/oar/src/contracts/answer.js";
import type { RequestRecord } from "../packages/oar/src/contracts/records.js";
import { eventsOf } from "../packages/oar/src/observe/events.js";
import { createQuestionAnswers, type QuestionDelivery } from "../packages/oar/src/shared/app-request-questions.js";
import { createSessionKernel } from "../packages/oar/src/shared/session-kernel.js";

const ANSWERS: AppQuestionAnswers = { answers: { "Which colour?": "Blue", "Which sizes?": ["Small", "Large"] } };

function answering(deliver: (request: RequestRecord, answers: AppQuestionAnswers) => QuestionDelivery | Promise<QuestionDelivery> = (_request, answers) => ({ reply: { answers: answers.answers } })) {
  const kernel = createSessionKernel("root-session");
  kernel.opened({ requested: "auto", placement: "in_process" });
  const settled: QuestionAnswerOutcome[] = [];
  const questions = createQuestionAnswers({ kernel, deliver, onSettled: (outcome) => { settled.push(outcome); } });
  return { kernel, questions, settled };
}

describe("the host-answered question round-trip", () => {
  it("records a host answer with the answers payload, never an approval decision", async () => {
    const { kernel, questions, settled } = answering();
    questions.request("q-1", "can_use_tool", { request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [] } } });
    const request = kernel.records().find((record): record is RequestRecord => record.kind === "request" && record.direction === "toApp");
    assert.ok(request !== undefined);
    const outcome = await questions.answer("q-1", ANSWERS);
    expect(outcome).toMatchObject({ kind: "unconfirmed", requestId: "q-1", seq: request.seq, answers: ANSWERS, native: { answers: ANSWERS.answers } });
    expect(outcome.response?.body).toMatchObject({ kind: "answered", by: "host" });
    expect(settled).toHaveLength(1);
    expect(questions.pending()).toEqual([]);
    expect(eventsOf(request)).toMatchObject([{ kind: "app_request", requestId: "q-1", type: "can_use_tool" }]);
    const response = kernel.records().find((record) => record.kind === "response" && record.requestId === "q-1");
    assert.ok(response !== undefined);
    expect(eventsOf(response)).toMatchObject([{ kind: "app_answered", requestId: "q-1", by: "host" }]);
  });

  it("answers once; a duplicate, an unknown id and a pre-aborted signal write nothing", async () => {
    const { kernel, questions } = answering();
    questions.request("q-1", "can_use_tool", {});
    await questions.answer("q-1", ANSWERS);
    await expect(questions.answer("q-1", ANSWERS)).resolves.toMatchObject({ kind: "rejected", code: "already_answered" });
    await expect(questions.answer("never-seen", ANSWERS)).resolves.toMatchObject({ kind: "rejected", code: "unknown_request", seq: -1 });
    const controller = new AbortController();
    controller.abort();
    questions.request("q-2", "can_use_tool", {});
    await expect(questions.answer("q-2", ANSWERS, { signal: controller.signal })).resolves.toMatchObject({ kind: "aborted", code: "answer_aborted" });
    expect(kernel.records().filter((record) => record.kind === "response" && record.body.kind === "answered")).toHaveLength(1);
  });

  it("a native withdrawal, dispose and exit stop the wait", async () => {
    const cancelled = answering();
    cancelled.questions.request("q-1", "can_use_tool", {});
    cancelled.kernel.frame({ type: "native/cancel", native: { requestId: "q-1" }, events: [{ kind: "app_request_cancelled", requestId: "q-1" }] });
    await expect(cancelled.questions.answer("q-1", ANSWERS)).resolves.toMatchObject({ kind: "aborted", code: "cancelled" });

    const disposed = answering();
    disposed.questions.request("q-2", "can_use_tool", {});
    const releasing = disposed.kernel.dispose(async () => { disposed.kernel.processExited(0); });
    await expect(disposed.questions.answer("q-2", ANSWERS)).resolves.toMatchObject({ kind: "aborted", code: "disposed" });
    await releasing;

    const exited = answering();
    exited.questions.request("q-3", "can_use_tool", {});
    exited.kernel.processExited(1);
    await expect(exited.questions.answer("q-3", ANSWERS)).resolves.toMatchObject({ kind: "aborted", code: "runtime_exited" });
  });

  it("reports accepted on a native receipt and does not wait out a caller abort", async () => {
    const receipt = Promise.withResolvers<void>();
    const accepted = answering(() => ({ reply: { ok: true }, acknowledged: receipt.promise }));
    accepted.questions.request("q-1", "can_use_tool", {});
    const pending = accepted.questions.answer("q-1", ANSWERS, { timeoutMs: 50 });
    receipt.resolve();
    await expect(pending).resolves.toMatchObject({ kind: "accepted", answers: ANSWERS });

    const dispatched = Promise.withResolvers<void>();
    const never = Promise.withResolvers<void>();
    const slow = answering(() => {
      dispatched.resolve();
      return { reply: { ok: true }, acknowledged: never.promise };
    });
    slow.questions.request("q-2", "can_use_tool", {});
    const controller = new AbortController();
    const started = Date.now();
    const waiting = slow.questions.answer("q-2", ANSWERS, { timeoutMs: 10_000, signal: controller.signal });
    await dispatched.promise;
    controller.abort();
    await expect(waiting).resolves.toMatchObject({ kind: "unconfirmed", answers: ANSWERS });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("keeps a question pending when no host answers: there is no policy answer", async () => {
    const { questions } = answering();
    questions.request("q-1", "can_use_tool", {});
    await delay(20);
    expect(questions.pending()).toEqual(["q-1"]);
    expect(questions.capability).toMatchObject({ kinds: [], questions: true, unanswered: { decision: "wait" } });
  });
});
