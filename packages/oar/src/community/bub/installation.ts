import path from "node:path";
import { environmentHome } from "../../shared/environment-home.js";
import { executableInstallation } from "../../shared/installation.js";

const BUB_VERSION = /^bub\s+(\d+\.\d+\.\d+\S*)$/u;

/** `bub --version` prints `bub <version>` (`bub 0.6.3.dev1+gb2e54493a` for a build from main). */
export function readBubVersion(stdout: string): string | undefined {
  return BUB_VERSION.exec(stdout.trim())?.[1];
}

/**
 * `bub` on PATH, else `~/.local/bin/bub`, where the official installer links
 * its virtual environment's `bub` (hosts that never read the shell profile
 * may not have that folder on PATH). `acp` is a plugin command, so the help
 * check runs `bub acp --help`: a Bub without the `bub-acp-server` plugin has
 * no `acp` command and is not usable.
 */
export const bubInstallation = executableInstallation(
  "OAR_BUB_BIN",
  "bub",
  (env) => [path.join(environmentHome(env), ".local", "bin", "bub")],
  ["acp", "--help"],
  {
    readVersion: readBubVersion,
    identity: { vendor: "Bub", help: /Run Bub as an ACP agent over stdio/u, version: BUB_VERSION },
  },
);
