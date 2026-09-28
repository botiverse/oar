import assert from "node:assert/strict";
import type { RequestRecord, ResponseRecord } from "../../packages/oar/src/contracts/session.js";
import type { TrialCase } from "../harness/runner.js";

// Generous on purpose: a runtime process that ignores the stop is killed after
// a few seconds; this bound only catches a dispose that never returns.
const DISPOSE_SETTLES_MS = 15_000;

/** Whether `work` settles within `ms`: a hang fails the case instead of stalling the suite. */
async function settlesWithin(ms: number, work: Promise<unknown>): Promise<boolean> {
  const { promise: expired, resolve } = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => {
    resolve(false);
  }, ms);
  const settled = (async (): Promise<boolean> => {
    await work;
    return true;
  })();
  try {
    return await Promise.race([settled, expired]);
  } finally {
    clearTimeout(timer);
  }
}

export const sessionDisposeCases: readonly TrialCase[] = [
  {
    // dispose is the control a host must be able to count on: it settles
    // mid-turn too (a runtime process that ignores the stop is killed with
    // what it started once a grace period is over; tests/session-dispose.test.ts
    // pins that with a stand-in agent). Race-honest: the turn may end before
    // the dispose lands; either way the dispose is answered and control closes.
    id: "session.dispose-mid-turn-settles",
    requires: ["installation", "session"],
    async run(subject) {
      const session = await subject.startSession();
      const started = await session.prompt("please answer slow-ly");
      assert.equal(started.response.body.kind, "accepted", `the slow prompt was not accepted: ${JSON.stringify(started.response.body)}`);
      assert.ok(await settlesWithin(DISPOSE_SETTLES_MS, session.dispose()), `dispose mid-turn did not settle within ${String(DISPOSE_SETTLES_MS)} ms`);
      const records = session.records();
      const dispose = records.find((record): record is RequestRecord => record.kind === "request" && record.body.kind === "dispose");
      assert.ok(dispose !== undefined, "dispose is a request record");
      const answer = records.find((record): record is ResponseRecord => record.kind === "response" && record.requestId === dispose.id);
      assert.ok(answer !== undefined && (answer.body.kind === "exited" || answer.body.kind === "accepted"), `the observed release answers the dispose request: ${JSON.stringify(answer?.body)}`);
      const after = await session.prompt("after dispose");
      assert.equal(after.response.body.kind, "rejected", "a disposed session rejects further control");
    },
  },
];
