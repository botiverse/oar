import type { Installer, InstallPlanner } from "../../contracts/install.js";
import type { InstallationProbe } from "../../contracts/installation.js";
import { planInstaller } from "../../shared/install.js";
import { npmInstallPlan, type NpmInstallMethod } from "../../shared/install-npm.js";

/** Documented npm package install across Linux, macOS and Windows (`--ignore-scripts`). */
export const piInstallMethod: NpmInstallMethod = {
  packageName: "@earendil-works/pi-coding-agent",
  source: "https://github.com/earendil-works/pi#getting-started",
  ignoreScripts: true,
};

export const piInstallPlan = npmInstallPlan(piInstallMethod);

/** Guard standalone CLI installation against missing host peers or an existing unsupported `pi` copy. */
export function createPiInstallPlan(installation: InstallationProbe): InstallPlanner {
  return async (options) => {
    if (options?.line !== undefined) { return piInstallPlan(options); }
    const existing = await installation();
    if (existing.kind === "unsupported") {
      return {
        kind: "unsupported",
        reason: "configuration",
        detail: existing.code === "dependency_missing"
          ? existing.reason
          : `${existing.reason}. Installing via npm does not replace this existing selection; upgrade or remove it before installing.`,
      };
    }
    return piInstallPlan(options);
  };
}

/** Build an installer for a configured standalone `pi` probe so pre/post checks share its discovery rules. */
export function createPiInstall(installation: InstallationProbe): Installer {
  return planInstaller(installation, createPiInstallPlan(installation));
}
