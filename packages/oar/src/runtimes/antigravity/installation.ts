import { homedir } from "node:os";
import path from "node:path";
import { environmentHome } from "../../shared/environment-home.js";
import { executableInstallation } from "../../shared/installation.js";

/** The CLI prints a bare version; the registry server prints a build stamp. */
export function readAntigravityVersion(stdout: string): string | undefined {
  return /^Build label:\s*(\S+)/mu.exec(stdout)?.[1]
    ?? /^(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\s*$/u.exec(stdout.trim())?.[1];
}

/** The official installer defaults to ~/.local/bin, often absent from GUI PATH. */
export function antigravityInstalledExecutableCandidates(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): readonly string[] {
  const paths = platform === "win32" ? path.win32 : path.posix;
  return [
    paths.join(home, ".local", "bin", platform === "win32" ? "agy.exe" : "agy"),
    platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par",
  ];
}

// The override is still exclusive. CLI discovery takes precedence over the
// older registry server; both keep their own native credential stores.
export const antigravityInstallation = executableInstallation(
  "OAR_ANTIGRAVITY_BIN",
  "agy",
  (env) => antigravityInstalledExecutableCandidates(process.platform, environmentHome(env)),
  undefined,
  { versionTimeoutMs: 30_000, readVersion: readAntigravityVersion },
);
