import { environmentHome } from "../../shared/environment-home.js";
import { homedir } from "node:os";
import path from "node:path";
import { executableInstallation } from "../../shared/installation.js";

/** Verified OpenCode 1.x baseline (docs/runtimes/opencode.md). */
export const OPENCODE_V1_MINIMUM_VERSION = "1.18.30";

/** Verified OpenCode 2.x floor: first 2.x release with working cold `models --standalone` (docs/runtimes/opencode.md). */
export const OPENCODE_V2_MINIMUM_VERSION = "2.0.27";

/** Supported OpenCode version range across both release lines, bounded below major 3. */
export const OPENCODE_SUPPORTED_VERSION_RANGE = `>=${OPENCODE_V1_MINIMUM_VERSION} <2.0.0 || >=${OPENCODE_V2_MINIMUM_VERSION} <3.0.0`;

/** Extract a semver token from `opencode --version` (`1.18.30` on v1, `opencode v2.2.7` on v2). */
export function parseOpencodeSemver(raw: string): string | undefined {
  return /^(?:opencode\s+)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/u.exec(raw.trim())?.[1];
}

/**
 * The install script's directory, `~/.opencode/bin`, which a GUI process's
 * PATH can miss. npm (`opencode-ai`), Homebrew and Scoop copies are on PATH.
 */
export function opencodeInstalledExecutableCandidates(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): readonly string[] {
  const paths = platform === "win32" ? path.win32 : path.posix;
  return [paths.join(home, ".opencode", "bin", platform === "win32" ? "opencode.exe" : "opencode")];
}

/** `opencode --version` is retained verbatim: v1 prints 1.x; v2 prints "opencode v2.x". */
export const opencodeInstallation = executableInstallation(
  "OAR_OPENCODE_BIN",
  "opencode",
  (env) => opencodeInstalledExecutableCandidates(process.platform, environmentHome(env)),
  ["--help"],
  {
    versionTimeoutMs: 15_000,
    identity: { vendor: "OpenCode", help: /\bopencode\b/iu },
    versionPolicy: {
      label: "OpenCode",
      lines: [
        { major: 1, min: OPENCODE_V1_MINIMUM_VERSION },
        { major: 2, min: OPENCODE_V2_MINIMUM_VERSION },
      ],
      required: OPENCODE_SUPPORTED_VERSION_RANGE,
      parseVersion: parseOpencodeSemver,
    },
  },
);
