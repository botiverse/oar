import { homedir } from "node:os";
import path from "node:path";
import { planInstaller, scriptInstallPlan, type ScriptInstallMethod } from "../../shared/install.js";
import { factoryInstallation } from "./installation.js";

/**
 * Factory's installer, documented at https://docs.factory.ai/cli/getting-started/quickstart.
 * It downloads the release for this OS and CPU from downloads.factory.ai,
 * checks it against its published SHA-256 and copies it to
 * `$HOME/.local/bin/droid`, the install `droid update` updates. It never
 * prompts and edits no shell profile (it prints the PATH line to add).
 */
export const factoryInstallMethod: ScriptInstallMethod = {
  source: "https://docs.factory.ai/cli/getting-started/quickstart",
  line: "curl -fsSL https://app.factory.ai/cli | sh",
  tools: ["curl", "sh"],
  writes: () => [path.join(homedir(), ".local", "bin")],
  windows: "Factory documents, in PowerShell: irm https://app.factory.ai/cli/windows | iex",
};

export const factoryInstallPlan = scriptInstallPlan(factoryInstallMethod);

export const factoryInstall = planInstaller(factoryInstallation, factoryInstallPlan);
