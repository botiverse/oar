import { homedir } from "node:os";
import path from "node:path";
import type { AvailableInstallation } from "../../contracts/installation.js";
import type { InstallLine } from "../../contracts/install.js";
import { linedInstallPlan, planInstaller, type ScriptInstallMethod } from "../../shared/install.js";
import { releaseVersion } from "../../shared/update.js";
import { opencodeInstallation } from "./installation.js";

/**
 * OpenCode ships two major lines of the same `opencode` command in parallel:
 * OpenCode 1 (npm `opencode-ai`, 1.x) and OpenCode 2 (npm `@opencode/cli`,
 * 2.x, a rewrite with a new plugin and server API). They do not install side
 * by side: both install scripts write `~/.opencode/bin/opencode`; the 2
 * installer replaces a 1 binary (https://opencode.ai/v2/docs/migrate-v1),
 * and the 1 script silently replaces a 2 binary with 1
 * (https://github.com/anomalyco/opencode/issues/54084).
 * So oar never chooses a line for the person, and an install never runs over
 * a copy of either line: the probe finds it first (`already_installed`).
 */
export const opencodeInstallLines: readonly InstallLine[] = [
  { line: "v1", description: "OpenCode 1: the opencode-ai 1.x releases" },
  { line: "v2", description: "OpenCode 2: the @opencode/cli 2.x releases, with a new plugin and server API" },
];

const writes = (): readonly string[] => [path.join(homedir(), ".opencode", "bin")];

/**
 * Each line's install script as OpenCode documents it first, downloading
 * that line's latest release to `~/.opencode/bin/opencode`, never prompting,
 * and adding the folder to the shell profile when one exists (it creates
 * none). Chosen because each line's own `opencode upgrade` takes that path as
 * its `curl` method (v1: packages/opencode/src/installation/index.ts) and
 * stays on the line: in the sandbox both answered "Using method: curl".
 * OpenCode documents no script for Windows.
 */
export const opencodeInstallMethods: Readonly<Record<string, ScriptInstallMethod>> = {
  v1: {
    source: "https://opencode.ai/docs/#install",
    line: "curl -fsSL https://opencode.ai/install | bash",
    tools: ["curl", "bash"],
    writes,
    windows: "OpenCode recommends WSL, or npm install -g opencode-ai, Scoop or Chocolatey",
  },
  v2: {
    source: "https://opencode.ai/v2/docs/",
    line: "curl -fsSL https://opencode.ai/v2/install | bash",
    tools: ["curl", "bash"],
    writes,
    windows: "OpenCode documents no script for OpenCode 2 there; its packages (npm install -g @opencode/cli) are on https://opencode.ai/v2/docs/",
  },
};

/** `opencode --version`: `1.18.35` on line 1, `opencode v2.0.26` on line 2. */
export function opencodeLineOf(installation: AvailableInstallation): string | undefined {
  const version = installation.via === "executable" && installation.version !== undefined ? releaseVersion(installation.version) : undefined;
  const major = version?.split(".")[0];
  return major === undefined ? undefined : opencodeInstallLines.find((entry) => entry.line === `v${major}`)?.line;
}

export const opencodeInstallPlan = linedInstallPlan({ lines: opencodeInstallLines, methods: opencodeInstallMethods });

export const opencodeInstall = planInstaller(opencodeInstallation, opencodeInstallPlan, opencodeLineOf);
