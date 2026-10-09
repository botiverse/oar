import { homedir } from "node:os";
import path from "node:path";
import { installDir, planInstaller, scriptInstallPlan, type ScriptInstallMethod } from "../../shared/install.js";
import { kimiInstallation } from "./installation.js";

/**
 * Moonshot's native installer, documented at
 * https://github.com/MoonshotAI/kimi-code#install. It installs the release
 * `code.kimi.com/kimi-code/latest` names as `$KIMI_INSTALL_DIR/bin/kimi`
 * (default `~/.kimi-code/bin/kimi`), the native copy `kimi upgrade` stages
 * updates for, and records region `mainland-cn` (the `code.kimi.com` source
 * `checkUpdate` then reads; the region only seeds the first login). It never
 * prompts; it adds its folder to the shell profile and renames an older
 * Python `kimi-cli` shim it finds first on PATH to `kimi-legacy`, where this
 * user can write.
 */
export const kimiInstallMethod: ScriptInstallMethod = {
  source: "https://github.com/MoonshotAI/kimi-code#install",
  line: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
  tools: ["curl", "bash"],
  writes: () => {
    const home = path.join(homedir(), ".kimi-code");
    return [installDir(process.env.KIMI_INSTALL_DIR, home), installDir(process.env.KIMI_CODE_HOME, home)];
  },
  windows: "Moonshot documents, in PowerShell: irm https://code.kimi.com/kimi-code/install.ps1 | iex",
};

export const kimiInstallPlan = scriptInstallPlan(kimiInstallMethod);

export const kimiInstall = planInstaller(kimiInstallation, kimiInstallPlan);
