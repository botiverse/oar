import type { TrialCase } from "../runner.js";

export const accountUsageCases: readonly TrialCase[] = [
  {
    id: "account-usage.snapshot",
    requires: ["installation", "accountUsage"],
    async run(subject) {
      const installation = await subject.runtime.installation?.();
      if (installation === undefined) {
        throw new Error("installation capability disappeared");
      }
      if (installation.kind !== "available") {
        return;
      }
      const snapshot = await subject.runtime.accountUsage?.(installation);
      if (snapshot === undefined) {
        throw new Error("account usage capability disappeared");
      }
      if (snapshot.kind === "available") {
        for (const window of snapshot.windows) {
          if (window.usedRatio < 0 || window.usedRatio > 1) {
            throw new Error("account usage ratio is outside 0..1");
          }
        }
      }
    },
  },
];
