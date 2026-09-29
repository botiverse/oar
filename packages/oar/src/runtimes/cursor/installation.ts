import { homedir } from "node:os";
import path from "node:path";
import { executableInstallation } from "../../shared/installation.js";

/**
 * The official installer's layout, which can be invisible to GUI-process
 * PATH: `~/.local/bin/cursor-agent` links into
 * `~/.local/share/cursor-agent/versions/<version>/` (cursor-agent 2026.09.28).
 * The installer also links `~/.local/bin/agent`, a name too generic to probe.
 */
export function cursorInstalledExecutableCandidates(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): readonly string[] {
  if (platform === "win32") {
    return [];
  }
  return [path.posix.join(home, ".local", "bin", "cursor-agent")];
}

export const cursorInstallation = executableInstallation(
  "OAR_CURSOR_BIN",
  "cursor-agent",
  cursorInstalledExecutableCandidates,
  ["acp", "--help"],
  { readinessTimeoutMs: 30_000, versionTimeoutMs: 30_000 },
);
