import { expect, test } from "vitest";
import { setImmediate as settle } from "node:timers/promises";
import { steerRun, stopOrphan } from "../../packages/oar/src/runtimes/cursor/run.js";
import type { CursorFrame } from "../../packages/oar/src/runtimes/cursor/projection.js";
import type { CursorRun } from "../../packages/oar/src/runtimes/cursor/sdk.js";
import { FakeCursorRun } from "../fixtures/fake-cursor-sdk.js";

// oxlint-disable-next-line eslint/max-statements -- the late run's cancellation and complete evidence order.
test("a run returned after disposal still drains buffered summaries before its cancelled result", async () => {
  const run = new FakeCursorRun("late-run", "work", () => {});
  const frames: CursorFrame[] = [];
  const started = { type: "summary", status: "running", agent_id: "agent-1", run_id: "late-run" };
  run.streamMessage(started);
  stopOrphan(run, (frame) => { frames.push(frame); });
  await settle();
  expect(run.cancelled).toBe(true);
  expect(run.streamDrained).toBe(true);
  expect(frames.map((frame) => frame.type)).toEqual(["cursor/stream/summary", "cursor/run_result"]);
  expect(frames[0]?.native).toBe(started);
  expect(frames.flatMap((frame) => frame.events).filter((event) => event.kind.startsWith("compaction_"))).toEqual([{ kind: "compaction_started" }]);
});

// A cursor session has `steer`; a run whose SDK object has no `run.steer` is
// cursor declining mid-run input for that run, the runtime's own refusal.
// `unsupported` stays for inputs a steer cannot carry (images).
test("a run that takes no mid-run input refuses the steer as the runtime's word", async () => {
  const run: CursorRun = {
    id: "run-1",
    async *stream() { yield* []; },
    wait: async () => {
      await Promise.resolve();
      throw new Error("never waited on");
    },
    cancel: async () => {
      await Promise.resolve();
    },
  };
  expect(await steerRun({ run, ended: Promise.withResolvers<void>().promise }, "also this")).toEqual({
    kind: "rejected",
    code: "runtime_refused",
    reason: "not_steerable: this cursor run takes no mid-run input",
  });
});
