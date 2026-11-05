import path from "node:path";
import type { InstallationProbe } from "../../contracts/installation.js";
import { environmentValue, sessionEnvironment } from "../../shared/environment.js";
import { environmentHome } from "../../shared/environment-home.js";
import { executableInstallation } from "../../shared/installation.js";
import { versionAtLeast } from "../../shared/update.js";

/** The standalone CLI prints a bare release, unlike the retired ACP server's build stamp. */
export function readAntigravityVersion(stdout: string): string | undefined {
  const releases = stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => /^\d+\.\d+\.\d+(?:-[A-Za-z\d.-]+)?$/u.test(line));
  return releases.length === 1 ? releases[0] : undefined;
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
  const env = sessionEnvironment(options?.env);
  const snapshot = await cliInstallation(options);
  if (snapshot.kind !== "available" || snapshot.via !== "executable") { return snapshot; }
  if (supported(snapshot.version)) { return snapshot; }
  const pinned = environmentValue(env, "OAR_ANTIGRAVITY_BIN");
  if (pinned === undefined || pinned === "") {
    for (const candidate of antigravityInstalledExecutableCandidates(process.platform, environmentHome(env), env)) {
      if (candidate === snapshot.command) { continue; }
      // The official install may be newer than a copy earlier on PATH.
      // oxlint-disable-next-line no-await-in-loop -- Probe candidates in discovery order.
      const fallback = await cliInstallation({ env: { ...options?.env, OAR_ANTIGRAVITY_BIN: candidate } });
      if (fallback.kind === "available" && fallback.via === "executable" && supported(fallback.version)) { return fallback; }
    }
  }
  return { kind: "unsupported", reason: `Antigravity requires a stable agy CLI 1.5.0 or newer with native ACP; ${snapshot.command} reports ${snapshot.version ?? "an unrecognized CLI version"}. Update that CLI or point OAR_ANTIGRAVITY_BIN at a supported agy, not agy_acp_server` };
};

function supported(version: string | undefined): boolean {
  return version !== undefined && /^\d+\.\d+\.\d+$/u.test(version) && versionAtLeast(version, "1.5.0");
};
