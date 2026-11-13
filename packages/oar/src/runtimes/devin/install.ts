import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { InstallPlanner } from "../../contracts/install.js";
import { environmentHome } from "../../shared/environment-home.js";
import { environmentValue } from "../../shared/environment.js";
import { installDir, planInstaller, scriptInstallPlan, type ScriptInstallMethod } from "../../shared/install.js";
import { devinInstallation, devinInstalledExecutableCandidates } from "./installation.js";

/** The official Devin CLI installer places the binary in XDG_DATA_HOME/devin and links ~/.local/bin/devin. */
export const devinInstallMethod: ScriptInstallMethod = {
  source: "https://docs.devin.ai/cli",
  line: "curl -fsSL https://cli.devin.ai/install.sh | bash",
  tools: ["curl", "bash"],
  writes: () => {
    const home = homedir();
    const dataHome = installDir(process.env.XDG_DATA_HOME, path.join(home, ".local", "share"));
    return [path.join(home, ".local", "bin"), path.join(dataHome, "devin"), path.join(dataHome, "man", "man1")];
  },
  windows: "Cognition documents, in PowerShell: irm https://static.devin.ai/cli/setup.ps1 | iex",
};

const nativePlan = scriptInstallPlan(devinInstallMethod);

/** Plan a standalone Devin CLI installation, refusing unsupported overrides and non-symlink regular files. */
export const devinInstallPlan: InstallPlanner = async (options) => {
  const planned = await nativePlan(options);
  if (options?.line !== undefined) {
    return planned;
  }
  const pinned = environmentValue(process.env, "OAR_DEVIN_BIN");
  const official = devinInstalledExecutableCandidates(process.platform, environmentHome(process.env), process.env)[0];
  if (process.platform !== "win32" && (pinned === undefined || pinned === "") && official !== undefined) {
    try {
      const stat = lstatSync(official);
      if (!stat.isSymbolicLink() && stat.isFile()) {
        return {
          kind: "unsupported",
          reason: "configuration",
          detail: `${official} exists and is not a symlink; the official Devin installer refuses to overwrite regular files.`,
        };
      }
    } catch {
      // Destination does not exist yet; continue with installation probing.
    }
  }
  const existing = await devinInstallation();
  const destination = existing.kind === "unsupported" && (pinned === undefined || pinned === "") && official !== undefined
    ? await devinInstallation({ env: { OAR_DEVIN_BIN: official } })
    : existing;
  if (existing.kind === "unsupported" && ((pinned !== undefined && pinned !== "") || destination.kind === "unsupported")) {
    return {
      kind: "unsupported",
      reason: "configuration",
      detail: `${existing.reason}. The installer does not upgrade this existing selection; update it or change the override before installing.`,
    };
  }
  if (existing.kind === "not_found" && pinned !== undefined && pinned !== "") {
    return {
      kind: "unsupported",
      reason: "configuration",
      detail: `OAR_DEVIN_BIN selects ${pinned}, which was not found. The installer cannot change this override; correct or unset it before installing.`,
    };
  }
  return planned;
};

export const devinInstall = planInstaller(devinInstallation, devinInstallPlan);
