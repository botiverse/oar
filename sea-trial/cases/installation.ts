import type { TrialCase } from "../runner.js";

export const installationCases: readonly TrialCase[] = [
  {
    id: "installation.snapshot",
    requires: ["installation"],
    async run(subject) {
      const snapshot = await subject.runtime.installation?.probe();
      if (snapshot === undefined) throw new Error("installation capability disappeared");
      if (snapshot.runtime !== subject.id) throw new Error("installation runtime id mismatch");
      if (snapshot.observedAt.length === 0) throw new Error("installation observation has no time");
      if (snapshot.state === "available" && snapshot.source === undefined) {
        throw new Error("available installation has no source evidence");
      }
    },
  },
];
