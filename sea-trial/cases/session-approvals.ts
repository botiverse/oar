import assert from "node:assert/strict";
import type { AppAsk, Session, TurnOutcome } from "../../packages/oar/src/contracts/session.js";
import { viewOf } from "../../packages/oar/src/observe/session-view.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { APPROVAL_PROBE, APPROVAL_PROBE_COMMAND } from "../harness/aimock.js";
import type { TrialCase } from "../harness/runner.js";
import type { RuntimeUnderTest } from "../harness/subject.js";

/*
 * SessionOptions.approvals and Session.answer (contracts/session.ts):
 * - "ask" opens only where capabilities.approvals is supported; elsewhere
 *   the open rejects naming why.
 * - an answer is recorded like every control, and a refused one carries one
 *   typed code.
 * - under "ask" a gated action is a toApp request with what it asks, holding
 *   its turn (status `awaiting`, the view's pending request) until answered;
 *   the answer lets the turn go on to the runtime's own end.
 * - no request looks pending forever: an abort withdraws it (or, in ACP,
 *   answers it `cancelled`), a dispose voids it.
 * The probe asks for a shell command no runtime's gate lets through unasked;
 * it is always denied, so nothing runs (aimock backends script the call).
 */

const APPROVAL_PROMPT = `${APPROVAL_PROBE}: use your shell tool to run exactly this command in the working directory, then say done: ${APPROVAL_PROBE_COMMAND}`;
const ASK_TIMEOUT_MS = 120_000;

interface Asked {
  readonly requestId: string;
  readonly ask: AppAsk;
}

/** An ask session, or null once the runtime is shown to declare no approvals (and to refuse the open for it). */
async function openAsking(subject: RuntimeUnderTest): Promise<Session | null> {
  const opened = await subject.startSession({ approvals: "ask" }).then(
    (session) => ({ session }),
    (error: unknown) => ({ error }),
  );
  if ("session" in opened) {
    assert.equal(opened.session.capabilities.approvals.kind, "supported", "an ask session opened, so its runtime declares approvals");
    return opened.session;
  }
  const plain = await subject.startSession();
  const declared = plain.capabilities.approvals;
  await plain.dispose();
  assert.ok(declared.kind === "unsupported", `the ask open failed although approvals are declared supported: ${String(opened.error)}`);
  return null;
}

/** The first runtime→app request with an ask after `afterSeq`, bounded; failing when the turn ends first. */
async function nextAsk(session: Session, afterSeq: number): Promise<Asked> {
  const { promise, resolve, reject } = Promise.withResolvers<Asked>();
  const timer = setTimeout(() => {
    reject(new Error(`no approval asked within ${String(ASK_TIMEOUT_MS)} ms of seq ${String(afterSeq)}`));
  }, ASK_TIMEOUT_MS);
  const stop = session.events((event) => {
    if (event.kind === "app_request" && event.ask !== undefined) {
      resolve({ requestId: event.requestId, ask: event.ask });
    }
    if (event.kind === "turn_ended" && event.sessionId === session.id && event.agentPath.length === 0) {
      reject(new Error(`the turn ended ${JSON.stringify(event.outcome)} without asking: under approvals "ask", "${APPROVAL_PROBE_COMMAND}" must be gated`));
    }
  }, { cursor: { sessionId: session.id, afterSeq } });
  try {
    const asked = await promise;
    return asked;
  } finally {
    clearTimeout(timer);
    stop();
  }
}

/** Deny every approval the turn still asks for (a model may retry another way) until the runtime ends it. */
async function endDenying(session: Session, afterSeq: number): Promise<TurnOutcome> {
  const denials: Promise<unknown>[] = [];
  const stop = session.events((event) => {
    if (event.kind === "app_request" && event.ask?.kind === "tool_approval" && event.ask.choices.includes("deny")) {
      denials.push(session.answer(event.requestId, { kind: "deny" }));
    }
  }, { cursor: { sessionId: session.id, afterSeq: session.records().at(-1)?.seq ?? afterSeq } });
  try {
    const outcome = await awaitTurnEnd(session, afterSeq);
    await Promise.all(denials);
    return outcome;
  } finally {
    stop();
  }
}

/** Resolves once no view of the stream shows `requestId` pending, bounded: the runtime may say so just after its turn end (codex). */
async function settles(session: Session, requestId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (viewOf(session.records()).pendingRequests.some((pending) => pending.requestId === requestId)) {
    assert.ok(Date.now() < deadline, `request ${requestId} still looks pending 10 s after its turn ended`);
    // oxlint-disable-next-line no-await-in-loop -- polling a bounded settle
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
}

function assertTaken(outcome: { readonly kind: string }, what: string): void {
  assert.equal(outcome.kind, "accepted", `${what} was not taken: ${JSON.stringify(outcome)}`);
}

export const sessionApprovalsCases: readonly TrialCase[] = [
  {
    // Token-free on every backend: the declaration and the open agree.
    id: "session.approvals-declared-or-refused",
    requires: ["installation", "session"],
    async run(subject) {
      const plain = await subject.startSession();
      const declared = plain.capabilities.approvals;
      await plain.dispose();
      if (declared.kind === "unsupported") {
        await assert.rejects(subject.startSession({ approvals: "ask" }), (error: unknown) => String(error).includes(declared.reason), "an ask open on a runtime without approvals names the declared reason");
        return;
      }
      const asking = await subject.startSession({ approvals: "ask" });
      assert.deepEqual(asking.capabilities.approvals, declared, "an ask session declares what a plain one does");
      await asking.dispose();
    },
  },
  {
    // Token-free on every backend: an answer is a recorded control with a typed refusal.
    id: "session.answer-rejections-are-recorded",
    requires: ["installation", "session"],
    async run(subject) {
      const session = await subject.startSession();
      const unknown = await session.answer("oar-no-such-request", { kind: "allow" });
      assert.ok(unknown.kind === "rejected" && unknown.code === "unknown_request", `an answer to no request: ${JSON.stringify(unknown.response.body)}`);
      assert.deepEqual(unknown.request.body, { kind: "answer", requestId: "oar-no-such-request", decision: { kind: "allow" } }, "the answer request carries the decision");
      const rejected: string[] = [];
      session.events((event) => {
        if (event.kind === "control_rejected") {
          rejected.push(`${event.action}:${event.code}`);
        }
      }, { cursor: { sessionId: session.id, afterSeq: -1 } });
      assert.deepEqual(rejected, ["answer:unknown_request"], "the refusal is a control_rejected event naming the answer");
      await session.dispose();
      const late = await session.answer("oar-no-such-request", { kind: "allow" });
      assert.ok(late.kind === "rejected" && (late.code === "disposed" || late.code === "runtime_exited"), `an answer after dispose: ${JSON.stringify(late.response.body)}`);
    },
  },
  {
    id: "session.approval-holds-the-turn-until-answered",
    requires: ["installation", "session"],
    async run(subject) {
      const session = await openAsking(subject);
      if (session === null) {
        return;
      }
      const prompt = await session.prompt(APPROVAL_PROMPT);
      assertTaken(prompt, "the probe prompt");
      const { requestId, ask } = await nextAsk(session, prompt.seq);
      assert.equal(ask.kind, "tool_approval", `the gate asks for the command: ${JSON.stringify(ask)}`);
      assert.ok(ask.choices.includes("deny"), `a tool approval can be denied: ${JSON.stringify(ask.choices)}`);
      const status = session.status().value;
      assert.ok(status.kind === "running" && status.awaiting?.includes(requestId) === true, `the turn is held, awaiting the host: ${JSON.stringify(status)}`);
      assert.ok(viewOf(session.records()).pendingRequests.some((pending) => pending.requestId === requestId && pending.ask !== undefined), "the view lists the request pending, with its ask");
      assertTaken(await session.answer(requestId, { kind: "deny" }), "the deny");
      assert.ok(session.records().some((record) => record.kind === "response" && record.requestId === requestId && record.body.kind === "answered"), "the reply sent is the request's answered response");
      const again = await session.answer(requestId, { kind: "allow" });
      assert.ok(again.kind === "rejected" && again.code === "already_answered", `the first answer stands: ${JSON.stringify(again.response.body)}`);
      const outcome = await endDenying(session, prompt.seq);
      assert.notEqual(outcome.kind, "failed", `a denial goes on to the runtime's own turn end, not a failure: ${JSON.stringify(outcome)}`);
      assert.equal(session.status().value.awaiting, undefined, "nothing is awaited once the turn ended");
      await session.dispose();
    },
  },
  {
    id: "session.approval-withdrawn-when-aborted",
    requires: ["installation", "session"],
    async run(subject) {
      const session = await openAsking(subject);
      if (session === null) {
        return;
      }
      const prompt = await session.prompt(APPROVAL_PROMPT);
      assertTaken(prompt, "the probe prompt");
      const { requestId } = await nextAsk(session, prompt.seq);
      assertTaken(await session.abort(), "the abort of a turn held by an approval");
      const outcome = await awaitTurnEnd(session, prompt.seq);
      assert.notEqual(outcome.kind, "failed", `the abort ends the held turn: ${JSON.stringify(outcome)}`);
      await settles(session, requestId);
      const late = await session.answer(requestId, { kind: "allow" });
      assert.ok(late.kind === "rejected" && (late.code === "withdrawn" || late.code === "already_answered"), `an answer after the abort: ${JSON.stringify(late.response.body)}`);
      assert.equal(session.status().value.awaiting, undefined, "nothing is awaited after the abort");
      await session.dispose();
    },
  },
  {
    id: "session.approval-void-on-dispose",
    requires: ["installation", "session"],
    async run(subject) {
      const session = await openAsking(subject);
      if (session === null) {
        return;
      }
      const prompt = await session.prompt(APPROVAL_PROMPT);
      assertTaken(prompt, "the probe prompt");
      const { requestId } = await nextAsk(session, prompt.seq);
      await session.dispose();
      assert.ok(!viewOf(session.records()).pendingRequests.some((pending) => pending.requestId === requestId), "a disposed session's request is no longer pending");
      assert.equal(session.status().value.awaiting, undefined, "nothing is awaited after dispose");
      const late = await session.answer(requestId, { kind: "allow" });
      assert.ok(late.kind === "rejected" && (late.code === "disposed" || late.code === "runtime_exited"), `an answer after dispose: ${JSON.stringify(late.response.body)}`);
    },
  },
];
