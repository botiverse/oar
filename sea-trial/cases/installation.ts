import assert from "node:assert/strict";
import type { TrialCase } from "../harness/runner.js";

export const installationCases: readonly TrialCase[] = [
  {
    id: "installation.snapshot",
    requires: ["installation"],
    async run(subject) {
      const snapshot = await subject.runtime.installation?.();
      assert.ok(snapshot !== undefined, "installation capability disappeared");
      if (snapshot.kind === "unsupported") {
        assert.ok(snapshot.reason.length > 0, "unsupported installation has no reason");
      }
      if (snapshot.kind === "available" && snapshot.via === "executable") {
        assert.ok(snapshot.command.length > 0, "available executable installation has no command");
      }
    },
  },
];
