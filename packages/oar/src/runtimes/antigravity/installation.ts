import path from "node:path";
import type { InstallationProbe } from "../../contracts/installation.js";
import { environmentValue } from "../../shared/environment.js";
import { environmentHome } from "../../shared/environment-home.js";
import { executableInstallation } from "../../shared/installation.js";
import { versionAtLeast } from "../../shared/update.js";

/** The standalone CLI prints a bare release, unlike the retired ACP server's build stamp. */
export function readAntigravityVersion(stdout: string): string | undefined {
  return /^(\d+\.\d+\.\d+)\s*$/u.exec(stdout.trim())?.[1];
}

/** Official installer locations, including GUI hosts whose PATH omits them. */
export function antigravityInstalledExecutableCandidates(
  platform: NodeJS.Platform,
  home: string,
  env: Readonly<NodeJS.ProcessEnv>,
): readonly string[] {
  if (platform === "win32") {
    const configured = environmentValue(env, "LOCALAPPDATA", platform);
    const local = configured === undefined || configured.length === 0 ? path.win32.join(home, "AppData", "Local") : configured;
    return [path.win32.join(local, "agy", "bin", "agy.exe")];
  }
  return [path.posix.join(home, ".local", "bin", "agy")];
}

const cliInstallation = executableInstallation(
  "OAR_ANTIGRAVITY_BIN", "agy",
  (env) => antigravityInstalledExecutableCandidates(process.platform, environmentHome(env), env),
  undefined,
  { versionTimeoutMs: 30_000, readVersion: readAntigravityVersion },
);

/** Older CLI releases accept unknown subcommands by printing help, so a successful help exit is not an ACP gate. */
export const antigravityInstallation: InstallationProbe = async (options) => {
  const snapshot = await cliInstallation(options);
  if (snapshot.kind !== "available" || snapshot.via !== "executable") { return snapshot; }
  return snapshot.version !== undefined && versionAtLeast(snapshot.version, "1.5.0")
    ? snapshot
    : { kind: "unsupported", reason: "Antigravity requires agy CLI 1.5.0 or newer with native ACP; update agy and point OAR_ANTIGRAVITY_BIN at agy, not agy_acp_server" };
};
