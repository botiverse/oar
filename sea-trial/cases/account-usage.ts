import type { TrialCase } from "../runner.js";

export const accountUsageCases: readonly TrialCase[] = [
  {
    id: "account-usage.snapshot",
    requires: ["accountUsage"],
    async run(subject) {
      const snapshot = await subject.runtime.accountUsage?.read();
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
