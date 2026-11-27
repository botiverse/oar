import { environmentValue, sessionEnvironment } from "./environment.js";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { InstallationProbe, InstallationSnapshot } from "../contracts/installation.js";
import { resolveExecutable, resolveExecutableAll } from "./executable/index.js";
import { probeCandidate, type ExecutableInstallationOptions, type LocatedExecutable } from "./installation-probe.js";

export type { ExecutableIdentity, ExecutableInstallationOptions, LocatedExecutable } from "./installation-probe.js";
export { clearInstallationCache } from "./installation-probe.js";

export type ExecutableFallbacks = readonly string[] | ((env: Readonly<NodeJS.ProcessEnv>) => readonly string[]);

function isPinnedPath(entry: string): boolean {
  return entry.includes("/") || entry.includes("\\");
}

/**
 * Where an installation entry is, found without spawning anything: a pinned
 * path must exist as given, a bare name resolves on PATH (and PATHEXT on
 * Windows). Null when it is not there.
 */
export function locateExecutable(entry: string, env: Readonly<NodeJS.ProcessEnv> = process.env): string | null {
  if (isPinnedPath(entry)) {
    return existsSync(entry) ? entry : null;
  }
  return resolveExecutable(entry, env);
}

/** A bare command on PATH, like `which -a`: the copy that runs and the ones after it. Null when there is none. */
export function locateOnPath(name: string, env: Readonly<NodeJS.ProcessEnv> = process.env): LocatedExecutable | null {
  const matches = resolveExecutableAll(name, env);
  const [command] = matches;
  return command === undefined ? null : { command, shadowed: shadowedCopies(matches) };
}

function realPath(file: string): string {
  try {
    return realpathSync.native(file);
  } catch {
    return path.resolve(file);
  }
}

/**
 * The copies PATH lists after the first of `matches` (which runs), in PATH
 * order, each once and as PATH spells it. Paths that resolve to one file are
 * one copy: a folder listed twice, `/bin` and `/usr/bin` on merged-usr Linux,
 * a symlink to the running copy. A folder holds one copy, the first match
 * there: Windows runs the first PATHEXT extension it finds, and the other
 * launchers beside it (npm writes `codex.cmd` and `codex.ps1` together) are
 * the same installation.
 */
export function shadowedCopies(matches: readonly string[]): readonly string[] {
  const folders = new Set<string>();
  const files = new Set<string>();
  const shadowed: string[] = [];
  for (const match of matches) {
    const folder = realPath(path.dirname(match));
    if (folders.has(folder)) {
      continue;
    }
    folders.add(folder);
    const file = realPath(match);
    if (files.has(file)) {
      continue;
    }
    if (files.size > 0) {
      shadowed.push(match);
    }
    files.add(file);
  }
  return shadowed;
}

function locateCandidate(entry: string, env: Readonly<NodeJS.ProcessEnv>): LocatedExecutable | null {
  if (isPinnedPath(entry)) {
    return existsSync(entry) ? { command: entry, shadowed: [] } : null;
  }
  return locateOnPath(entry, env);
}

/**
 * An installation probed from an executable: the env var pins one candidate
 * exclusively; otherwise the command name and fallbacks are tried in order and
 * the first usable candidate wins. Readiness, vendor identity and version
 * policies are enforced in one place for every candidate. When no candidate is
 * usable, a `version_unsupported` refusal takes precedence so updaters can
 * still upgrade an older vendor installation behind an unrelated PATH copy.
 *
 * One candidate's probe (installation-probe.ts) runs the readiness check and
 * the version read beside each other and shares an in-progress run with any
 * other caller asking for the same executable at the same time: a host pays
 * one native boot for both questions, and one boot in total when two of its
 * paths ask at once.
 */
export function executableInstallation(
  envVar: string,
  command: string,
  fallbacks: ExecutableFallbacks = [],
  readiness?: readonly string[],
  options: ExecutableInstallationOptions = {},
): InstallationProbe {
  return async (probe = {}): Promise<InstallationSnapshot> => {
    const env = sessionEnvironment(probe.env);
    const pinned = envVar === "" ? undefined : environmentValue(env, envVar);
    const found: LocatedExecutable[] = [];
    if (pinned !== undefined && pinned !== "") {
      const located = locateExecutable(pinned, env);
      if (located !== null) {
        found.push({ command: located, shadowed: [] });
      }
    } else {
      for (const entry of [command, ...(typeof fallbacks === "function" ? fallbacks(env) : fallbacks)]) {
        const candidate = locateCandidate(entry, env);
        if (candidate !== null && !found.some((other) => other.command === candidate.command)) {
          found.push(candidate);
        }
      }
    }

    if (found.length === 0) {
      return { kind: "not_found" };
    }
    let firstRefusal: InstallationSnapshot | null = null;
    let versionRefusal: InstallationSnapshot | null = null;
    for (const candidate of found) {
      // oxlint-disable-next-line no-await-in-loop -- Candidates are probed in discovery order until one is usable.
      const snapshot = await probeCandidate(candidate, readiness, options, env);
      if (snapshot.kind === "available") {
        return snapshot;
      }
      firstRefusal ??= snapshot;
      if (snapshot.kind === "unsupported" && snapshot.code === "version_unsupported") {
        versionRefusal ??= snapshot;
      }
    }
    return versionRefusal ?? firstRefusal ?? { kind: "not_found" };
  };
}
