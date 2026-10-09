import { homedir } from "node:os";
import path from "node:path";
import { installDir, planInstaller, scriptInstallPlan, type ScriptInstallMethod } from "../../shared/install.js";
import { codexInstallation } from "./installation.js";

/**
 * OpenAI's standalone installer, documented at
 * https://github.com/openai/codex#installing-and-running-codex-cli. It
 * unpacks the release into `$CODEX_HOME/packages/standalone/releases`, points
 * `current` at it and links `$CODEX_INSTALL_DIR/codex` (default
 * `~/.local/bin/codex`) there: the layout `codex doctor` reports as
 * `standalone installer` and `codex update` reruns. `CODEX_NON_INTERACTIVE=1`
 * is the installer's own switch that skips its prompts (start codex now,
 * remove an npm or Homebrew copy). It adds its folder to PATH in the shell
 * profile, which a running host does not read, so the probe looks there too.
 */
export const codexInstallMethod: ScriptInstallMethod = {
  source: "https://github.com/openai/codex#installing-and-running-codex-cli",
  line: "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh",
  tools: ["curl"],
  writes: () => [
    installDir(process.env.CODEX_INSTALL_DIR, path.join(homedir(), ".local", "bin")),
    installDir(process.env.CODEX_HOME, path.join(homedir(), ".codex")),
  ],
  windows: "OpenAI documents: powershell -ExecutionPolicy ByPass -c \"irm https://chatgpt.com/codex/install.ps1 | iex\"",
};

export const codexInstallPlan = scriptInstallPlan(codexInstallMethod);

export const codexInstall = planInstaller(codexInstallation, codexInstallPlan);
