import type { TrialCase } from "../runner.js";

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
      if (
        snapshot.kind === "available" && snapshot.via === "bundled"
        && snapshot.version !== undefined && snapshot.version.length === 0
      ) {
        throw new Error("available bundled installation has an empty version");
      }
    },
  },
];
