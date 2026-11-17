import assert from "node:assert/strict";
import type { TrialCase } from "../harness/runner.js";

export const sessionCapabilitiesCases: readonly TrialCase[] = [
  {
    // What the runtime declares before open is what the opened session offers;
    // an absent field promises nothing.
    id: "session.capabilities-match-declaration",
    requires: ["installation", "session", "sessionCapabilities"],
    async run(subject) {
      const installation = await subject.runtime.installation?.();
      assert.ok(installation?.kind === "available", "the subject opens sessions from an available installation");
      const declared = subject.runtime.sessionCapabilities?.(installation);
      assert.ok(declared !== undefined);
      const session = await subject.startSession();
      try {
        if (declared.steer !== undefined) {
          assert.equal(session.steer !== undefined, declared.steer, "declared steer matches Session.steer");
        }
        if (declared.images !== undefined) {
          assert.equal(session.capabilities.images, declared.images, "declared images matches capabilities.images");
        }
      } finally {
        await session.dispose();
      }
    },
  },
];
