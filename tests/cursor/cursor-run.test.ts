import { expect, test } from "vitest";
import { steerRun } from "../../packages/oar/src/runtimes/cursor/run.js";
import type { CursorRun } from "../../packages/oar/src/runtimes/cursor/sdk.js";

// A cursor session has `steer`; a run whose SDK object has no `run.steer` is
// cursor declining mid-run input for that run, the runtime's own refusal.
// `unsupported` stays for inputs a steer cannot carry (images).
test("a run that takes no mid-run input refuses the steer as the runtime's word", async () => {
  const run: CursorRun = {
    id: "run-1",
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
