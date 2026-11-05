import { homedir } from "node:os";
import path from "node:path";
import { planInstaller, scriptInstallPlan, type ScriptInstallMethod } from "../../shared/install.js";
import { antigravityInstallation } from "./installation.js";

/** The official CLI installer verifies its release manifest and installs ~/.local/bin/agy. */
export const antigravityInstallMethod: ScriptInstallMethod = {
  source: "https://antigravity.google/docs/cli",
  line: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
  tools: ["curl", "bash"],
  writes: () => [path.join(homedir(), ".local", "bin"), path.join(homedir(), ".cache", "antigravity"), homedir()],
  windows: "Google documents, in PowerShell: irm https://antigravity.google/cli/install.ps1 | iex",
};

export const antigravityInstallPlan = scriptInstallPlan(antigravityInstallMethod);
export const antigravityInstall = planInstaller(antigravityInstallation, antigravityInstallPlan);
