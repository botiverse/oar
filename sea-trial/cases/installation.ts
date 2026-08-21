import type { TrialCase } from "../runner.js";

export const installationCases: readonly TrialCase[] = [
  {
    id: "installation.snapshot",
    requires: ["installation"],
    async run(subject) {
      const snapshot = await subject.runtime.installation?.probe();
      if (snapshot === undefined) {
        throw new Error("installation capability disappeared");
      }
      if (snapshot.kind === "unsupported" && snapshot.reason.length === 0) {
        throw new Error("unsupported installation has no reason");
      }
    },
  },
];
