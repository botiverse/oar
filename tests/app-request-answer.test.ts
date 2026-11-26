/* oxlint-disable eslint/max-statements, eslint/max-lines-per-function, import/max-dependencies -- One contract case per documented outcome; grouping them keeps the round-trip readable. */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { AppRequestDecision, AnswerOutcome } from "../packages/oar/src/contracts/answer.js";
import type { RequestRecord } from "../packages/oar/src/contracts/records.js";
import { eventsOf } from "../packages/oar/src/observe/events.js";
import { createAppRequestAnswers, type AppRequestDelivery } from "../packages/oar/src/shared/app-request-answers.js";
import { createSessionKernel } from "../packages/oar/src/shared/session-kernel.js";
import { sessionCredentialRedactor } from "../packages/oar/src/shared/credential-redactor.js";

const ALLOW: AppRequestDecision = { decision: "allow", scope: "once" };
const DENY: AppRequestDecision = { decision: "deny", reason: "the host said no" };

function opened(redact?: <T>(value: T) => T) {
  const kernel = createSessionKernel("root-session", redact);
  kernel.opened({ requested: "auto", placement: "in_process" });
  return kernel;
}

/** A coordinator whose replies are immediate and unacknowledged unless a test overrides `deliver`. */
function answering(deliver: (request: RequestRecord, decision: AppRequestDecision) => AppRequestDelivery | Promise<AppRequestDelivery> = (_request, decision) => ({ reply: { decision: decision.decision } })) {
  const kernel = opened();
  const settled: AnswerOutcome[] = [];
  const answers = createAppRequestAnswers({ kernel, deliver, onSettled: (outcome) => { settled.push(outcome); } });
  return { kernel, answers, settled };
}

describe("the host-answered approval round-trip", () => {
  it("correlates the runtime's request id and records one host answer", async () => {
    const { kernel, answers, settled } = answering();
    answers.request("tool-1", "approval", { tool: "Write", input: "main.ts" });
    const request = kernel.records().find((record): record is RequestRecord => record.kind === "request" && record.direction === "toApp");
    assert.ok(request !== undefined);

    const outcome = await answers.answer("tool-1", ALLOW);
    expect(outcome).toMatchObject({ kind: "unconfirmed", requestId: "tool-1", seq: request.seq, decision: ALLOW, native: { decision: "allow" } });
    expect(outcome.request).toBe(request);
    expect(outcome.response).toMatchObject({ kind: "response", requestId: "tool-1", body: { kind: "answered", native: { decision: "allow" }, by: "host" } });
    expect(settled).toHaveLength(1);
    expect(answers.pending()).toEqual([]);
    expect(eventsOf(request)).toMatchObject([{ kind: "app_request", requestId: "tool-1", type: "approval" }]);
    const response = kernel.records().find((record) => record.kind === "response" && record.requestId === "tool-1");
    assert.ok(response !== undefined);
    expect(eventsOf(response)).toMatchObject([{ kind: "app_answered", requestId: "tool-1", by: "host" }]);
  });

  it("reports accepted only when the protocol acknowledged the reply", async () => {
    const acknowledged = Promise.withResolvers<void>();
    const { answers } = answering(() => ({ reply: { ok: true }, acknowledged: acknowledged.promise }));
    answers.request("tool-1", "approval", {});
    const pending = answers.answer("tool-1", ALLOW, { timeoutMs: 50 });
    acknowledged.resolve();
    await expect(pending).resolves.toMatchObject({ kind: "accepted", decision: ALLOW, native: { ok: true } });
  });

  it("times out an acknowledgment wait without losing the written reply", async () => {
    const never = Promise.withResolvers<void>();
    const { kernel, answers } = answering(() => ({ reply: { ok: true }, acknowledged: never.promise }));
    answers.request("tool-1", "approval", {});
    const outcome = await answers.answer("tool-1", ALLOW, { timeoutMs: 5 });
    expect(outcome).toMatchObject({ kind: "timeout", code: "no_native_ack" });
    expect(kernel.records().filter((record) => record.kind === "response" && record.body.kind === "answered")).toHaveLength(1);
  });

  it("a caller's signal after dispatch ends the acknowledgment wait without unwriting the reply", async () => {
    const never = Promise.withResolvers<void>();
    const dispatched = Promise.withResolvers<void>();
    // The session's 10 s default is the bound the review saw waited out.
    const kernel = opened();
    const answers = createAppRequestAnswers({
      kernel,
      acknowledgeTimeoutMs: 10_000,
      deliver: () => {
        dispatched.resolve();
        return { reply: { ok: true }, acknowledged: never.promise };
      },
    });
    answers.request("tool-1", "approval", {});
    const controller = new AbortController();
    const started = Date.now();
    const pending = answers.answer("tool-1", ALLOW, { signal: controller.signal });
    await dispatched.promise;
    controller.abort();
    const outcome = await pending;
    expect(Date.now() - started).toBeLessThan(1000); // 10 s bound must not be waited out
    expect(outcome).toMatchObject({ kind: "unconfirmed", decision: ALLOW, native: { ok: true } });
    expect(outcome.response).toMatchObject({ kind: "response", body: { kind: "answered", by: "host" } });
    expect(kernel.records().filter((record) => record.kind === "response" && record.body.kind === "answered")).toHaveLength(1);
  });

  it("a native receipt after the caller stopped waiting changes no outcome and no duplicate is accepted", async () => {
    const acknowledged = Promise.withResolvers<void>();
    const dispatched = Promise.withResolvers<void>();
    const { kernel, answers } = answering(() => {
      dispatched.resolve();
      return { reply: { ok: true }, acknowledged: acknowledged.promise };
    });
    answers.request("tool-1", "approval", {});
    const controller = new AbortController();
    const pending = answers.answer("tool-1", ALLOW, { timeoutMs: 10_000, signal: controller.signal });
    await dispatched.promise;
    controller.abort();
    await expect(pending).resolves.toMatchObject({ kind: "unconfirmed" });
    acknowledged.resolve(); // the protocol settles late; the answer is already recorded
    await delay(10);
    expect(kernel.records().filter((record) => record.kind === "response" && record.body.kind === "answered")).toHaveLength(1);
    expect(answers.pending()).toEqual([]);
    await expect(answers.answer("tool-1", DENY)).resolves.toMatchObject({ kind: "rejected", code: "already_answered" });
  });

  it("a late receipt that fails after the caller stopped waiting is not an unhandled rejection", async () => {
    const acknowledged = Promise.withResolvers<void>();
    const dispatched = Promise.withResolvers<void>();
    const { answers } = answering(() => {
      dispatched.resolve();
      return { reply: { ok: true }, acknowledged: acknowledged.promise };
    });
    answers.request("tool-1", "approval", {});
    const controller = new AbortController();
    const pending = answers.answer("tool-1", ALLOW, { timeoutMs: 10_000, signal: controller.signal });
    await dispatched.promise;
    controller.abort();
    await expect(pending).resolves.toMatchObject({ kind: "unconfirmed" });
    acknowledged.reject(new Error("late transport failure"));
    await delay(10);
    expect(answers.pending()).toEqual([]);
  });

  it("refuses without writing when the transport fails, and keeps the request answerable", async () => {
    let failing = true;
    const { answers } = answering(() => {
      if (failing) {
        throw new Error("transport closed");
      }
      return { reply: { decision: "allow" } };
    });
    answers.request("tool-1", "approval", {});
    const refused = await answers.answer("tool-1", ALLOW);
    expect(refused).toMatchObject({ kind: "rejected", code: "error", reason: "transport closed" });
    expect(refused.response).toBeUndefined();
    expect(answers.pending()).toEqual(["tool-1"]);
    failing = false;
    await expect(answers.answer("tool-1", ALLOW)).resolves.toMatchObject({ kind: "unconfirmed" });
  });

  it("refuses a concurrent answer as busy and allows it once the first settles", async () => {
    const first = Promise.withResolvers<AppRequestDelivery>();
    const { answers } = answering(async () => {
      const delivery = await first.promise;
      return delivery;
    });
    answers.request("tool-1", "approval", {});
    const inFlight = answers.answer("tool-1", ALLOW);
    const busy = await answers.answer("tool-1", DENY);
    expect(busy).toMatchObject({ kind: "rejected", code: "busy" });
    first.resolve({ reply: { decision: "allow" } });
    await expect(inFlight).resolves.toMatchObject({ kind: "unconfirmed", decision: ALLOW });
  });

  it("answers once: a second answer, an unknown id and a non-approval kind write nothing", async () => {
    const { kernel, answers } = answering();
    answers.request("tool-1", "approval", {});
    answers.request("question-1", "elicitation", { message: "which?" });
    await answers.answer("tool-1", ALLOW);
    await expect(answers.answer("tool-1", DENY)).resolves.toMatchObject({ kind: "rejected", code: "already_answered" });
    await expect(answers.answer("never-seen", DENY)).resolves.toMatchObject({ kind: "rejected", code: "unknown_request", seq: -1 });
    await expect(answers.answer("question-1", DENY)).resolves.toMatchObject({ kind: "rejected", code: "not_answerable" });
    expect(kernel.records().filter((record) => record.kind === "response" && record.body.kind === "answered")).toHaveLength(1);
  });

  it("an adapter's own answer takes the request back", async () => {
    const { answers } = answering();
    answers.request("tool-1", "approval", {});
    answers.autoAnswer("tool-1", { decision: "deny" });
    expect(answers.pending()).toEqual([]);
    await expect(answers.answer("tool-1", ALLOW)).resolves.toMatchObject({ kind: "rejected", code: "already_answered" });
  });

  it("aborts on the runtime's withdrawal, the caller's signal, dispose and exit", async () => {
    const cancelled = answering();
    cancelled.answers.request("tool-1", "approval", {});
    cancelled.kernel.frame({ type: "native/cancel", native: { requestId: "tool-1" }, events: [{ kind: "app_request_cancelled", requestId: "tool-1" }] });
    await expect(cancelled.answers.answer("tool-1", ALLOW)).resolves.toMatchObject({ kind: "aborted", code: "cancelled" });
    expect(cancelled.settled).toHaveLength(1);

    const signalled = answering();
    signalled.answers.request("tool-2", "approval", {});
    const controller = new AbortController();
    controller.abort();
    await expect(signalled.answers.answer("tool-2", ALLOW, { signal: controller.signal })).resolves.toMatchObject({ kind: "aborted", code: "answer_aborted" });

    const exited = answering();
    exited.answers.request("tool-3", "approval", {});
    exited.kernel.processExited(2);
    await expect(exited.answers.answer("tool-3", ALLOW)).resolves.toMatchObject({ kind: "aborted", code: "runtime_exited" });

    const disposed = answering();
    disposed.answers.request("tool-4", "approval", {});
    const releasing = disposed.kernel.dispose(async () => { disposed.kernel.processExited(0); });
    await expect(disposed.answers.answer("tool-4", ALLOW)).resolves.toMatchObject({ kind: "aborted", code: "disposed" });
    await releasing;
  });

  it("a request id from a replaced stream is unknown, never carried across a resume", async () => {
    const first = answering();
    first.answers.request("tool-1", "approval", {});
    await first.answers.answer("tool-1", ALLOW);

    const resumed = answering();
    await expect(resumed.answers.answer("tool-1", ALLOW)).resolves.toMatchObject({ kind: "rejected", code: "unknown_request" });
  });

  it("answers by policy when no host does, marking the response OAR's own", async () => {
    const kernel = opened();
    const settled: AnswerOutcome[] = [];
    const answers = createAppRequestAnswers({
      kernel,
      unanswered: { afterMs: 5, decision: DENY },
      deliver: (_request, decision) => ({ reply: { decision: decision.decision } }),
      onSettled: (outcome) => { settled.push(outcome); },
    });
    answers.request("tool-1", "approval", {});
    await delay(20);
    expect(settled).toMatchObject([{ kind: "timeout", code: "unanswered", decision: DENY }]);
    expect(answers.pending()).toEqual([]);
    const response = kernel.records().find((record) => record.kind === "response" && record.requestId === "tool-1");
    assert.ok(response?.kind === "response" && response.body.kind === "answered");
    expect(response.body.by).toBeUndefined();
    await expect(answers.answer("tool-1", ALLOW)).resolves.toMatchObject({ kind: "timeout", code: "unanswered" });
  });

  it("redacts the recorded request and reply with the session's credentials", async () => {
    const redactor = sessionCredentialRedactor({ env: { SERVICE_TOKEN: "sk-secret-1234" } });
    const kernel = opened(redactor.redactValue);
    const answers = createAppRequestAnswers({ kernel, deliver: (_request, decision) => ({ reply: { decision: decision.decision, echo: "sk-secret-1234" } }) });
    answers.request("tool-1", "approval", { tool: "Write", input: "token=sk-secret-1234" });
    const outcome = await answers.answer("tool-1", ALLOW);
    const serialized = JSON.stringify(kernel.records());
    expect(serialized).not.toContain("sk-secret-1234");
    expect(serialized).toContain("[redacted]");
    if (outcome.kind !== "unconfirmed") { throw new Error(`expected an unconfirmed answer: ${JSON.stringify(outcome)}`); }
    expect(JSON.stringify(outcome.native)).toContain("sk-secret-1234"); // the runtime-facing value is not a record
    expect(outcome.response?.body).toMatchObject({ kind: "answered", native: { decision: "allow", echo: "[redacted]" } });
  });
});
