import { homedir } from "node:os";
import path from "node:path";
import { planInstaller, scriptInstallPlan, type ScriptInstallMethod } from "../../shared/install.js";
import { qoderInstallation } from "./installation.js";

/** The native installer owns the release manifest, integrity check and launchers; do not edit shell profiles. */
export const qoderInstallMethod: ScriptInstallMethod = {
  source: "https://docs.qoder.com/cli/troubleshoot-install",
  line: "curl -fsSL https://qoder.com/install | bash -s -- --skip-path",
  tools: ["curl", "bash"],
  writes: () => [path.join(homedir(), ".local", "bin"), path.join(homedir(), ".qoder")],
  windows: "Follow Qoder's official Windows installation instructions at https://docs.qoder.com/cli/troubleshoot-install",
};

export const qoderInstallPlan = scriptInstallPlan(qoderInstallMethod);
export const qoderInstall = planInstaller(qoderInstallation, qoderInstallPlan);
