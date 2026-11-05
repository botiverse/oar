import type { InstallPlanner } from "../../contracts/install.js";
import { environmentValue } from "../../shared/environment.js";
import { homedir } from "node:os";
import path from "node:path";
import { planInstaller, scriptInstallPlan, type ScriptInstallMethod } from "../../shared/install.js";
import { antigravityInstallation } from "./installation.js";

/** The official CLI installer verifies its release manifest and installs ~/.local/bin/agy. */
export const antigravityInstallMethod: ScriptInstallMethod = {
  source: "https://antigravity.google/docs/cli",
  line: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
  tools: ["curl", "bash"],
  writes: () => [path.join(homedir(), ".local", "bin"), path.join(homedir(), ".cache", "antigravity"), path.join(homedir(), ".bashrc"), path.join(homedir(), ".zshrc")],
  windows: "Google documents, in PowerShell: irm https://antigravity.google/cli/install.ps1 | iex",
};

const nativePlan = scriptInstallPlan(antigravityInstallMethod);

/** The vendor installer exits successfully without replacing an existing CLI. */
export const antigravityInstallPlan: InstallPlanner = async (options) => {
  const planned = await nativePlan(options);
  if (options?.line !== undefined) { return planned; }
  const existing = await antigravityInstallation();
  if (existing.kind === "unsupported") {
    return { kind: "unsupported", reason: "configuration", detail: `${existing.reason}. The installer does not upgrade this existing selection; update it or change the override before installing.` };
  }
  const pinned = environmentValue(process.env, "OAR_ANTIGRAVITY_BIN");
  if (existing.kind === "not_found" && pinned !== undefined && pinned !== "") {
    return { kind: "unsupported", reason: "configuration", detail: `OAR_ANTIGRAVITY_BIN selects ${pinned}, which was not found. The installer cannot change this override; correct or unset it before installing.` };
  }
  return planned;
};
export const antigravityInstall = planInstaller(antigravityInstallation, antigravityInstallPlan);
