import path from "node:path";
import { environmentValue } from "../../shared/environment.js";
import { environmentHome } from "../../shared/environment-home.js";
import { executableInstallation } from "../../shared/installation.js";

/** `devin --version` prints `devin <semver>` optionally followed by a short commit hash in parentheses. */
export function readDevinVersion(stdout: string): string | undefined {
  return /^devin\s+(\d+\.\d+\.\d+(?:-[A-Za-z\d.-]+)?)(?:\s+\([0-9a-f]+\))?$/u.exec(stdout.trim())?.[1];
}

/** Official installer locations, including GUI hosts whose PATH omits them. */
export function devinInstalledExecutableCandidates(
  platform: NodeJS.Platform,
  home: string,
  env: Readonly<NodeJS.ProcessEnv>,
): readonly string[] {
  if (platform === "win32") {
    const configured = environmentValue(env, "LOCALAPPDATA", platform);
    const local = configured === undefined || configured.length === 0 ? path.win32.join(home, "AppData", "Local") : configured;
    return [path.win32.join(local, "devin", "cli", "bin", "devin.exe")];
  }
  return [path.posix.join(home, ".local", "bin", "devin")];
}

export const devinInstallation = executableInstallation(
  "OAR_DEVIN_BIN",
  "devin",
  (env) => devinInstalledExecutableCandidates(process.platform, environmentHome(env), env),
  ["acp", "--help"],
  { versionTimeoutMs: 30_000, readVersion: readDevinVersion },
);
