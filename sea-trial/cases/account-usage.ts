import assert from "node:assert/strict";
import type { TrialCase } from "../harness/runner.js";

export const accountUsageCases: readonly TrialCase[] = [
  {
    id: "account-usage.snapshot",
    requires: ["installation", "accountUsage"],
    async run(subject) {
      const installation = await subject.runtime.installation?.();
      assert.ok(installation !== undefined, "installation capability disappeared");
      if (installation.kind !== "available") {
        return;
      }
      const snapshot = await subject.runtime.accountUsage?.(installation);
      assert.ok(snapshot !== undefined, "account usage capability disappeared");
      if (snapshot.kind === "available") {
        for (const window of snapshot.windows) {
          assert.ok(window.usedRatio >= 0 && window.usedRatio <= 1, "account usage ratio is outside 0..1");
        }
      }
    },
  },
];
