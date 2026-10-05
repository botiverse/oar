import type { InstallationProbe } from "../../contracts/installation.js";
import { runExecutable } from "../../shared/executable/index.js";
import { executableInstallation } from "../../shared/installation.js";

const executable = executableInstallation("OAR_MORPH_BIN", "morph", ["mistermorph"]);

/** `morph` rejects `--version`; its version is the `version` subcommand's "morph <version>" line. */
export const morphInstallation: InstallationProbe = async () => {
  const snapshot = await executable();
  if (snapshot.kind !== "available" || snapshot.via !== "executable" || snapshot.version !== undefined) {
    return snapshot;
  }
  const result = await runExecutable(snapshot.command, ["version"], { timeoutMs: 10_000 });
  const version = result.ok ? /^(?:morph|mistermorph)\s+(\S+)/mu.exec(result.stdout)?.[1] : undefined;
  return version === undefined ? snapshot : { ...snapshot, version };
};
