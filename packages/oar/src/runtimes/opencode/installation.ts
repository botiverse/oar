import { homedir } from "node:os";
import path from "node:path";
import { executableInstallation } from "../../shared/installation.js";

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

/** `opencode --version` (1.18.30) prints the bare release and takes about 2 s to start. */
export const opencodeInstallation = executableInstallation(
  "OAR_OPENCODE_BIN",
  "opencode",
  opencodeInstalledExecutableCandidates,
  undefined,
  { versionTimeoutMs: 15_000 },
);
