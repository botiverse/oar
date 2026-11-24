import path from "node:path";
import { environmentValue } from "../../shared/environment.js";
import { environmentHome } from "../../shared/environment-home.js";
import { executableInstallation } from "../../shared/installation.js";
import { hermesVersionPattern, readHermesVersion } from "./version.js";

export { readHermesVersion } from "./version.js";

/**
 * Official installer locations, including GUI hosts whose PATH omits them.
 *
 * The bootstrap installs the checkout at `$HERMES_HOME/hermes-agent` and
 * publishes `~/.local/bin/hermes`; the checkout's own launcher is the copy a
 * host without that symlink can still run. On Windows the native install lives
 * under `%LOCALAPPDATA%\hermes`.
 */
export function hermesInstalledExecutableCandidates(
  platform: NodeJS.Platform,
  home: string,
  env: Readonly<NodeJS.ProcessEnv>,
): readonly string[] {
  if (platform === "win32") {
    const configured = environmentValue(env, "LOCALAPPDATA", platform);
    const local = configured === undefined || configured.length === 0 ? path.win32.join(home, "AppData", "Local") : configured;
    return [
      path.win32.join(local, "hermes", "bin", "hermes.exe"),
      path.win32.join(local, "hermes", "bin", "hermes.cmd"),
    ];
  }
  return [
    path.posix.join(home, ".local", "bin", "hermes"),
    path.posix.join(home, ".hermes", "hermes-agent", ".hermes", "bin", "hermes"),
  ];
}

/**
 * `hermes acp --check` is the native readiness check for the ACP entry: it
 * verifies the optional `agent-client-protocol` dependency and imports the
 * adapter without starting a server. A Hermes install without the `acp` extra
 * therefore fails here instead of failing every session open later. The
 * version is read from `hermes --version`, the same executable OAR launches
 * with the `acp` subcommand.
 */
export const hermesInstallation = executableInstallation(
  "OAR_HERMES_BIN",
  "hermes",
  (env) => hermesInstalledExecutableCandidates(process.platform, environmentHome(env), env),
  ["acp", "--check"],
  {
    readinessTimeoutMs: 60_000,
    versionTimeoutMs: 30_000,
    readVersion: readHermesVersion,
    identity: {
      vendor: "Hermes Agent",
      help: /Hermes ACP check OK/u,
      version: hermesVersionPattern,
    },
  },
);
