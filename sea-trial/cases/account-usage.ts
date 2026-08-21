import type { TrialCase } from "../runner.js";

export const accountUsageCases: readonly TrialCase[] = [
  {
    id: "account-usage.snapshot",
    requires: ["accountUsage"],
    async run(subject) {
      const snapshot = await subject.runtime.accountUsage?.read({
        collectorVersion: "sea-trial",
        localAccountSlot: "fixture",
        observedAtMs: 0,
      });
      if (snapshot === undefined) {
        throw new Error("account usage capability disappeared");
      }
      if (snapshot.runtime !== subject.id) {
        throw new Error("account usage runtime id mismatch");
      }
      for (const account of snapshot.accounts) {
        if (!/^[a-f0-9]{64}$/u.test(account.accountKey)) {
          throw new Error("account key is not a sha256 hex digest");
        }
      }
    },
  },
];
