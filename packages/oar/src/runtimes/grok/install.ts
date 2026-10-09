import { homedir } from "node:os";
import path from "node:path";
import { installDir, planInstaller, scriptInstallPlan, type ScriptInstallMethod } from "../../shared/install.js";
import { grokInstallation } from "./installation.js";

/**
 * xAI's installer, documented at https://docs.x.ai/build/overview. It
 * downloads the stable release into `~/.grok/downloads` and links
 * `$GROK_BIN_DIR/grok` (default `~/.grok/bin/grok`) to it: the `internal`
 * install `grok update` updates (an npm copy would be a second one). It never
 * prompts. Besides adding its folder to the shell profile, it links `grok`
 * into `~/.local/bin` or `/usr/local/bin` when one is on PATH and writable.
 */
export const grokInstallMethod: ScriptInstallMethod = {
  source: "https://docs.x.ai/build/overview",
  line: "curl -fsSL https://x.ai/cli/install.sh | bash",
  tools: ["curl", "bash"],
  writes: () => {
    const home = path.join(homedir(), ".grok");
    return [installDir(process.env.GROK_BIN_DIR, path.join(home, "bin")), home];
  },
  windows: "xAI documents, in PowerShell: irm https://x.ai/cli/install.ps1 | iex",
};

export const grokInstallPlan = scriptInstallPlan(grokInstallMethod);

export const grokInstall = planInstaller(grokInstallation, grokInstallPlan);
