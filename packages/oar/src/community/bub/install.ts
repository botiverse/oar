import { homedir } from "node:os";
import path from "node:path";
import { planInstaller, scriptInstallPlan, type ScriptInstallMethod } from "../../shared/install.js";
import { bubInstallation } from "./installation.js";

/**
 * Bub's installer, documented at https://bub.build. It installs uv into
 * `~/.local/bin` when none is on PATH, creates `~/.bub/.venv`, links
 * `~/.local/bin/bub` and installs the plugins of the named preset; `acp`
 * brings `bub-acp-server`. A named preset never prompts and skips onboarding.
 */
export const bubInstallMethod: ScriptInstallMethod = {
  source: "https://bub.build",
  line: "curl -fsSL https://bub.build/install.sh | bash -s -- --preset acp",
  tools: ["curl", "bash"],
  writes: () => [path.join(homedir(), ".bub"), path.join(homedir(), ".local", "bin")],
  windows: "Bub documents only its bash installer",
};

export const bubInstallPlan = scriptInstallPlan(bubInstallMethod);
export const bubInstall = planInstaller(bubInstallation, bubInstallPlan);
