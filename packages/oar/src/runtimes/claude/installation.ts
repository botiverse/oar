import { homedir } from "node:os";
import path from "node:path";
import { executableInstallation } from "../../shared/installation.js";

/**
 * Where the native installer puts the launcher (`~/.local/bin/claude`, a link
 * into `~/.local/share/claude/versions/<version>`; `%USERPROFILE%\.local\bin\claude.exe`
 * on Windows), which a GUI or service process's PATH can miss: the installer
 * only prints a note when that folder is not on PATH
 * (https://code.claude.com/docs/en/troubleshoot-install). npm, Homebrew and
 * WinGet copies are on PATH.
 */
export function claudeInstalledExecutableCandidates(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): readonly string[] {
  const paths = platform === "win32" ? path.win32 : path.posix;
  return [paths.join(home, ".local", "bin", platform === "win32" ? "claude.exe" : "claude")];
}

export const claudeInstallation = executableInstallation("OAR_CLAUDE_BIN", "claude", claudeInstalledExecutableCandidates);
