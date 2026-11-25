import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { Event, RawEvent, RequestRecord } from "../../packages/oar/src/contracts/session.js";
import { appRequestKind } from "../../packages/oar/src/observe/app-requests.js";
import { eventsOf } from "../../packages/oar/src/observe/events.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { answerOrSkip, type TrialCase } from "../harness/runner.js";
import { accepted } from "../harness/session-controls.js";

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (condition()) {
      return;
    }
    await delay(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Every toApp request record the session has so far. */
function appRequests(records: readonly RawEvent[]): readonly RequestRecord[] {
  return records.filter((record): record is RequestRecord => record.kind === "request" && record.direction === "toApp");
}

export const sessionAnswerCases: readonly TrialCase[] = [
  {
    // The host-answered approval round-trip on the public API: the request is
    // a toApp record under the runtime's own id, one answer writes and
    // records the reply, the pair reads back as app_request/app_answered with
    // `by: "host"`, and a second answer or an unknown id writes nothing.
    // A session that never hands approvals to a host skips on `answer`.
    id: "session.answer-approval-round-trip",
    requires: ["installation", "session"],
    async run(subject) {
      const session = await subject.startSession();
      const answer = await answerOrSkip(session);
      const prompted = await accepted(session, "needs-approval");
      await until(() => appRequests(session.records()).length === 1, "the approval request");
      const [request] = appRequests(session.records());
      assert.ok(request !== undefined && request.body.kind === "native", "the request is a native toApp body");
      assert.equal(request.body.type, "approval");
      assert.equal(appRequestKind(request.body.type), "approval");
      assert.ok(session.capabilities.appRequests?.kinds.includes("approval") === true, "the capability declares host-owned approvals");

      const outcome = await answer(request.id, { decision: "allow", scope: "once" });
      assert.ok(outcome.kind === "accepted" || outcome.kind === "unconfirmed", `the reply was written: ${JSON.stringify(outcome)}`);
      assert.equal(outcome.requestId, request.id, "the outcome correlates to the request id");
      assert.equal(outcome.seq, request.seq, "the outcome points at the request's position in the stream");
      assert.equal(outcome.request, request, "the outcome carries the request record");
      assert.ok(outcome.response?.body.kind === "answered", "the answer records an answered response");
      assert.equal(outcome.response.body.by, "host");
      assert.deepEqual(outcome.response.body.native, { decision: "allow" });
      const answered = session.records().flatMap((record) => eventsOf(record))
        .filter((event): event is Extract<Event, { readonly kind: "app_answered" }> => event.kind === "app_answered");
      assert.deepEqual(answered.map((event) => [event.requestId, event.by]), [[request.id, "host"]]);

      const second = await answer(request.id, { decision: "deny" });
      assert.ok(second.kind === "rejected" && second.code === "already_answered", `one answer per request: ${JSON.stringify(second)}`);
      const unknown = await answer("no-such-request", { decision: "deny" });
      assert.ok(unknown.kind === "rejected" && unknown.code === "unknown_request", `an unrecorded id is unknown: ${JSON.stringify(unknown)}`);
      await awaitTurnEnd(session, prompted.request.seq);

      // A request still waiting when the session is disposed stops waiting;
      // its late answer writes nothing and says why.
      await accepted(session, "needs-approval");
      await until(() => appRequests(session.records()).length === 2, "the second approval request");
      const [pending] = appRequests(session.records()).slice(1);
      assert.ok(pending !== undefined);
      await session.dispose();
      const late = await answer(pending.id, { decision: "allow" });
      assert.equal(late.kind, "aborted", `a disposed session stops waiting: ${JSON.stringify(late)}`);
      assert.equal(late.response, undefined, "a stopped request was not answered");
    },
  },
];
