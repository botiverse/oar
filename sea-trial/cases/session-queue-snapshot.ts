import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { queueSnapshotOf, restoreQueue } from "../../packages/oar/src/observe/index.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { withdrawOrSkip, type TrialCase } from "../harness/runner.js";

/** How long a drained input would take to show up as a running turn, at the slowest scripted pace. */
const DRAIN_GRACE_MS = 1500;

export const sessionQueueSnapshotCases: readonly TrialCase[] = [
  {
    // A host that persists a queue snapshot (docs/spec/queue-snapshot.md) may
    // restore ONLY input the stream returned to it. Race-honest: the turn may
    // end and the held input be sent before the withdraw lands, so the case
    // asserts both outcomes' promises rather than one runtime's timing.
    id: "session.queue-snapshot-restores-only-returned-input",
    requires: ["installation", "session"],
    async run(subject) {
      const session = await subject.startSession();
      const withdraw = await withdrawOrSkip(session);
      const first = await session.prompt("answer briefly");
      assert.equal(first.kind, "accepted", JSON.stringify(first.response.body));
      const queued = await session.queue("and then this");
      assert.equal(queued.kind, "accepted", JSON.stringify(queued.response.body));
      assert.ok(queued.request.body.kind === "queue" && queued.request.body.inputId !== undefined, "a queue request carries its inputId");
      const { inputId } = queued.request.body;
      const taken = await withdraw(inputId);
      assert.ok(taken.kind === "accepted" || taken.code === "not_queued", `a withdraw is accepted or not_queued: ${JSON.stringify(taken.response.body)}`);
      await awaitTurnEnd(session, first.seq);
      await delay(DRAIN_GRACE_MS);
      const queueRequests = (): number => session.records().filter((record) => record.kind === "request" && record.body.kind === "queue").length;
      const before = queueRequests();
      const snapshot = queueSnapshotOf(session.records(), { streamId: "trial-before", sessionId: session.id });
      // A fresh logical id: the snapshot cannot prove the runtime never saw this one.
      const restored = await restoreQueue(session, snapshot, { streamId: "trial-after", inputId: () => globalThis.crypto.randomUUID() });
      for (const sent of restored.resent) {
        assert.notEqual(sent.entry.evidence.resend, "never", `restore resent input the stream says the runtime has (${sent.entry.evidence.code})`);
        assert.ok(sent.inputId !== inputId, "a restored input never reuses an id the runtime may have seen");
      }
      assert.equal(restored.resent.length, restored.plan.resends, "restore sends exactly what the plan counted");
      assert.equal(restored.resent.length + restored.skipped.length, restored.plan.entries.length, "every planned entry is either sent or reported");
      assert.equal(queueRequests(), before + restored.resent.length, "restore queues exactly the inputs it planned, once each");
      if (taken.kind === "accepted") {
        // The caller owns the withdrawn input again: the snapshot may restore it once, never twice.
        assert.ok(restored.resent.length <= 1, `a withdrawn input is planned at most once: ${String(restored.resent.length)}`);
      } else {
        // not_queued means the withdraw did not take it back, so nothing returned to the caller.
        assert.equal(restored.resent.length, 0, "no resend for input a refused withdraw did not return");
      }
      assert.equal(session.records().find((record) => record.seq === queued.seq), queued.request, "the original queue request stays as recorded");
      await session.dispose();
    },
  },
];
