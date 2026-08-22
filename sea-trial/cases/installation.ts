import type { TrialCase } from "../harness/runner.js";

export const installationCases: readonly TrialCase[] = [
  {
    id: "installation.snapshot",
    requires: ["installation"],
    async run(subject) {
      const snapshot = await subject.runtime.installation?.();
      if (snapshot === undefined) {
        throw new Error("installation capability disappeared");
      }
      if (snapshot.kind === "unsupported" && snapshot.reason.length === 0) {
        throw new Error("unsupported installation has no reason");
      }
      if (snapshot.kind === "available" && snapshot.via === "executable" && snapshot.command.length === 0) {
        throw new Error("available executable installation has no command");
      }
    },
  },
];
