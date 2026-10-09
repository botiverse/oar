import { homedir } from "node:os";
import path from "node:path";
import { planInstaller, scriptInstallPlan, type ScriptInstallMethod } from "../../shared/install.js";
import { claudeInstallation } from "./installation.js";

/**
 * Anthropic's native installer, documented at
 * https://code.claude.com/docs/en/setup. It downloads the release
 * `downloads.claude.ai/claude-code-releases/latest` names, checks it against
 * the release manifest and runs `claude install`, which links
 * `~/.local/bin/claude` into `~/.local/share/claude/versions/<version>`: the
 * native layout `claude update` updates, so `checkUpdate` reads the release
 * pointer for it. It needs no terminal and never prompts, and it does not
 * edit shell profiles (it prints the PATH line instead), so the probe looks
 * in `~/.local/bin` itself. Homebrew and WinGet copies would update through
 * their package manager instead (`checkUpdate`: `package_manager`).
 */
export const claudeInstallMethod: ScriptInstallMethod = {
  source: "https://code.claude.com/docs/en/setup",
  line: "curl -fsSL https://claude.ai/install.sh | bash",
  tools: ["curl", "bash"],
  writes: () => {
    const home = homedir();
    return [path.join(home, ".local", "bin"), path.join(home, ".local", "share", "claude"), path.join(home, ".claude")];
  },
  windows: "Anthropic documents, in PowerShell: irm https://claude.ai/install.ps1 | iex",
};

export const claudeInstallPlan = scriptInstallPlan(claudeInstallMethod);

export const claudeInstall = planInstaller(claudeInstallation, claudeInstallPlan);
