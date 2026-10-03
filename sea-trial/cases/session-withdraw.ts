import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { RawEvent, Session } from "../../packages/oar/src/contracts/session.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { withdrawOrSkip, type TrialCase } from "../harness/runner.js";

/** How long a drained input would take to show up as a running turn, at the slowest scripted pace. */
const DRAIN_GRACE_MS = 1500;

function rootTurnEndsAfter(records: readonly RawEvent[], seq: number): number {
  return records.filter((record) =>
    record.seq > seq && record.agentPath.length === 0 && record.kind === "frame" && record.body.events.some((view) => view.kind === "turn_ended")).length;
}

function echoedInput(session: Session, inputId: string): boolean {
  return session.records().some((record) => record.kind === "frame" && record.body.events.some((view) => view.kind === "user_message" && view.inputId === inputId));
}

export const sessionWithdrawCases: readonly TrialCase[] = [
  {
    // Race-honest: on a real runtime the turn may end, and the held input be
    // sent, before the withdraw lands; then it is not_queued and runs. What
    // every runtime with `withdraw` MUST honor: an accepted withdraw means
    // the input never runs, the queue request and its answer stay in the
    // stream as they were, and a dead session refuses it by the stream's
    // reachability rule. A session without `withdraw` (codex) skips.
    id: "session.withdraw-before-dispatch",
    requires: ["installation", "session"],
    async run(subject) {
      const session = await subject.startSession();
      const withdraw = await withdrawOrSkip(session);
      const first = await session.prompt("please answer slow-ly");
      assert.equal(first.kind, "accepted", JSON.stringify(first.response.body));
      const queued = await session.queue("and then this");
      assert.equal(queued.kind, "accepted", JSON.stringify(queued.response.body));
      assert.ok(queued.request.body.kind === "queue" && queued.request.body.inputId !== undefined, "a queue request carries its inputId");
      const { inputId } = queued.request.body;
      const taken = await withdraw(inputId);
      assert.deepEqual(taken.request.body, { kind: "withdraw", inputId }, "the withdraw is a request naming the input");
      assert.ok(taken.kind === "accepted" || taken.code === "not_queued", `a withdraw is accepted or not_queued: ${JSON.stringify(taken.response.body)}`);
      await awaitTurnEnd(session, first.seq);
      if (taken.kind === "accepted") {
        await delay(DRAIN_GRACE_MS);
        assert.equal(rootTurnEndsAfter(session.records(), first.seq), 1, "a withdrawn input never runs a turn of its own");
        assert.equal(session.status().value.kind, "idle", "nothing runs after the withdrawn input's would-be turn");
        assert.ok(!echoedInput(session, inputId), "the runtime never saw the withdrawn input");
        const again = await withdraw(inputId);
        assert.ok(again.kind === "rejected" && again.code === "not_queued", "an input already withdrawn is not_queued");
      }
      assert.equal(session.records().find((record) => record.seq === queued.seq), queued.request, "the queue request stays as recorded");
      const unknown = await withdraw("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
      assert.ok(unknown.kind === "rejected" && unknown.code === "not_queued", "an input never queued here is not_queued");
      await session.dispose();
      const late = await withdraw(inputId);
      assert.ok(late.kind === "rejected" && (late.code === "disposed" || late.code === "runtime_exited"), `a disposed session refuses withdraw by reachability: ${JSON.stringify(late.response.body)}`);
    },
  },
];
