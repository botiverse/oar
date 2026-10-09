import { homedir } from "node:os";
import path from "node:path";
import { executableInstallation } from "../../shared/installation.js";

/**
 * Copies a process's PATH can miss. The macOS Desktop app bundles the Codex
 * CLI instead of putting it on PATH; OpenAI relocated the app from Codex.app
 * to ChatGPT.app, so the new bundle is tried before the legacy one, and
 * system installs before per-user installs. Then the standalone installer's
 * launcher (https://chatgpt.com/codex/install.sh: `$CODEX_INSTALL_DIR/codex`,
 * by default `~/.local/bin/codex`, a link into
 * `$CODEX_HOME/packages/standalone/current`), which it adds to PATH only in
 * shell profiles.
 */
export function codexInstalledExecutableCandidates(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): readonly string[] {
  if (platform === "win32") {
    return [];
  }
  const paths = path.posix;
  const bundles = platform === "darwin"
    ? [
        "/Applications/ChatGPT.app/Contents/Resources/codex",
        "/Applications/Codex.app/Contents/Resources/codex",
        paths.join(home, "Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
        paths.join(home, "Applications", "Codex.app", "Contents", "Resources", "codex"),
      ]
    : [];
  const installDir = env.CODEX_INSTALL_DIR === undefined || env.CODEX_INSTALL_DIR === "" ? [] : [paths.join(env.CODEX_INSTALL_DIR, "codex")];
  return [...bundles, ...installDir, paths.join(home, ".local", "bin", "codex")];
}

// OAR drives Codex through its app-server surface; a codex without it is unsupported.
export const codexInstallation = executableInstallation(
  "OAR_CODEX_BIN",
  "codex",
  codexInstalledExecutableCandidates,
  ["app-server", "--help"],
);
