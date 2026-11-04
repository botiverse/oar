import { homedir } from "node:os";
import path from "node:path";
import { planInstaller, scriptInstallPlan, type ScriptInstallMethod } from "../../shared/install.js";
import { antigravityInstallation } from "./installation.js";

/** Google's installer verifies its release, then runs `agy install` for shell setup. */
export const antigravityInstallMethod: ScriptInstallMethod = {
  source: "https://antigravity.google/docs/getting-started/?tab=cli",
  line: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
  tools: ["curl", "bash"],
  writes: () => {
    const home = homedir();
    return [path.join(home, ".local", "bin"), path.join(home, ".cache", "antigravity"), home];
  },
  windows: "use Google's Windows installer at https://antigravity.google/docs/getting-started/?tab=cli",
};

export const antigravityInstallPlan = scriptInstallPlan(antigravityInstallMethod);
export const antigravityInstall = planInstaller(antigravityInstallation, antigravityInstallPlan);
