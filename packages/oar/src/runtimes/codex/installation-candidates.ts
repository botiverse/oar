import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { environmentValue } from "../../shared/environment.js";

/*
 * Where Codex can be installed off PATH, as plain synchronous functions with
 * no side effect beyond reading directories (the Desktop build folders). Its
 * own module and subpath, `@botiverse/oar/runtimes/codex/installation-candidates`,
 * so a host can list the candidates without loading the runtime or probing
 * anything. `codexInstallation` (installation.ts) probes them in order, after
 * `OAR_CODEX_BIN` and PATH, which this list does not include, and picks the
 * first that answers `codex app-server --help`.
 */

/**
 * Copies a process's PATH can miss. The macOS Desktop app bundles the Codex
 * CLI instead of putting it on PATH; OpenAI relocated the app from Codex.app
 * to ChatGPT.app, so the new bundle is tried before the legacy one, and
 * system installs before per-user installs. Then the standalone installer's
 * launcher (https://chatgpt.com/codex/install.sh: `$CODEX_INSTALL_DIR/codex`,
 * by default `~/.local/bin/codex`, a link into
 * `$CODEX_HOME/packages/standalone/current`), which it adds to PATH only in
 * shell profiles.
 *
 * On Windows (none of them on PATH): npm's global `codex.cmd` shim in its
 * default prefix (`%APPDATA%\npm`; OAR runs the shim's Node script without
 * cmd.exe, windows-shim.ts), then the Codex Desktop app's CLI
 * (`%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`, or without
 * `Programs` for a per-user install), then the same under
 * `%USERPROFILE%\AppData\Local` and the home folder's when those differ. Newer Desktop builds keep the CLI one
 * folder down, `bin\<build>\codex.exe` (a build hash; a user saw
 * `bin\5449c1f0f26f1f98\codex.exe`, 2026-11-11), and older build folders can
 * remain: after each fixed path come its build folders' CLIs, the most
 * recently written first, so the probe settles on the newest that works.
 * Locations as Raft's own Codex driver resolves them; the
 * `codex-command-runner` sandbox helper beside them is never a candidate.
 */
export function codexInstalledExecutableCandidates(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  builds: (bin: string) => readonly string[] = desktopBuildExecutables,
): readonly string[] {
  if (platform === "win32") {
    const win = path.win32;
    // Windows variable names are case-insensitive (`AppData` is `APPDATA`).
    const folder = (name: string, fallback: string): string => {
      const value = environmentValue(env, name, platform);
      return value === undefined || value === "" ? fallback : value;
    };
    const roaming = folder("APPDATA", win.join(home, "AppData", "Roaming"));
    // A process whose LOCALAPPDATA names another profile (a service, another
    // user's shell) still finds the Desktop app in the user's own profile.
    const profile = environmentValue(env, "USERPROFILE", platform);
    const locals: string[] = [];
    for (const root of [
      environmentValue(env, "LOCALAPPDATA", platform),
      profile === undefined || profile === "" ? undefined : win.join(profile, "AppData", "Local"),
      win.join(home, "AppData", "Local"),
    ]) {
      if (root !== undefined && root !== "" && !locals.some((seen) => seen.toLowerCase() === root.toLowerCase())) { locals.push(root); }
    }
    const desktop = locals.flatMap((local) => [win.join(local, "Programs", "OpenAI", "Codex", "bin"), win.join(local, "OpenAI", "Codex", "bin")]);
    const candidates = [win.join(roaming, "npm", "codex.cmd")];
    for (const bin of desktop) { candidates.push(win.join(bin, "codex.exe"), ...builds(bin)); }
    return candidates;
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

/** At most this many build folders are probed: Raft's own driver takes the newest three. */
const DESKTOP_BUILDS = 3;

/**
 * `<bin>\<build>\codex.exe` for the newest build folders that have one (at
 * most three, the most recently written first); none when `bin` cannot be
 * read. A folder whose name starts with `.` (a sandbox helper's, like
 * `.sandbox-bin`) is never a build.
 */
export function desktopBuildExecutables(bin: string): readonly string[] {
  let folders: readonly string[] = [];
  try { folders = readdirSync(bin, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name); }
  catch { return []; }
  return folders.flatMap((folder) => {
    // The real filesystem: the host's own separator (Windows when it matters).
    const file = path.join(bin, folder, "codex.exe");
    try { return [{ file, written: statSync(file).mtimeMs }]; } catch { return []; }
  }).toSorted((left, right) => right.written - left.written).slice(0, DESKTOP_BUILDS).map((entry) => entry.file);
}
