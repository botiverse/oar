import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { ExecutableInstallation, InstallationProbe, InstallationSnapshot } from "../contracts/installation.js";
import {
  readExecutableVersion,
  resolveExecutable,
  resolveExecutableAll,
  runExecutable,
  type VersionReader,
} from "./executable/index.js";
import { assertRan } from "./executable/diagnostics.js";

// An entry with a path separator is a pinned path: it must exist as given and
// never silently falls back to a different binary. A bare name resolves on PATH.
export interface ExecutableInstallationOptions {
  readonly readinessTimeoutMs?: number;
  readonly versionTimeoutMs?: number;
  /** For executables whose `--version` does not lead with the version. */
  readonly readVersion?: VersionReader;
}

export type ExecutableFallbacks = readonly string[] | (() => readonly string[]);

function isPinnedPath(entry: string): boolean {
  return entry.includes("/") || entry.includes("\\");
}

/**
 * Where an installation entry is, found without spawning anything: a pinned
 * path must exist as given, a bare name resolves on PATH (and PATHEXT on
 * Windows). Null when it is not there.
 */
export function locateExecutable(entry: string): string | null {
  if (isPinnedPath(entry)) {
    return existsSync(entry) ? entry : null;
  }
  return resolveExecutable(entry);
}

/** An executable found for an entry, and the copies on PATH it shadows (none for a pinned path). */
export interface LocatedExecutable {
  readonly command: string;
  readonly shadowed: readonly string[];
}

/** A bare command on PATH, like `which -a`: the copy that runs and the ones after it. Null when there is none. */
export function locateOnPath(name: string): LocatedExecutable | null {
  const matches = resolveExecutableAll(name);
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

function locateCandidate(entry: string): LocatedExecutable | null {
  if (isPinnedPath(entry)) {
    return existsSync(entry) ? { command: entry, shadowed: [] } : null;
  }
  return locateOnPath(entry);
}

async function versionSnapshot(
  { command, shadowed }: LocatedExecutable,
  options: ExecutableInstallationOptions,
): Promise<InstallationSnapshot> {
  const version = await readExecutableVersion(command, options.versionTimeoutMs, options.readVersion);
  const snapshot: ExecutableInstallation = {
    kind: "available",
    via: "executable",
    command,
    ...(version === undefined ? {} : { version }),
    ...(shadowed.length === 0 ? {} : { shadowed }),
  };
  return snapshot;
}

/**
 * An installation probed from an executable: the env var pins one candidate
 * exclusively; otherwise the command name and fallbacks are tried in order and
 * the first usable candidate wins. When readiness args are given, a candidate
 * must run them successfully or the probe moves on to the next one. The copies
 * a winner found on PATH shadows are reported, never for a pinned env var.
 */
export function executableInstallation(
  envVar: string,
  command: string,
  fallbacks: ExecutableFallbacks = [],
  readiness?: readonly string[],
  options: ExecutableInstallationOptions = {},
): InstallationProbe {
  return async (): Promise<InstallationSnapshot> => {
    const pinned = process.env[envVar];
    const found: LocatedExecutable[] = [];
    if (pinned !== undefined && pinned !== "") {
      const located = locateExecutable(pinned);
      if (located !== null) {
        found.push({ command: located, shadowed: [] });
      }
    } else {
      for (const entry of [command, ...(typeof fallbacks === "function" ? fallbacks() : fallbacks)]) {
        const candidate = locateCandidate(entry);
        if (candidate !== null && !found.some((other) => other.command === candidate.command)) {
          found.push(candidate);
        }
      }
    }

    const [first] = found;
    if (first === undefined) {
      return { kind: "not_found" };
    }
    if (readiness === undefined) {
      return versionSnapshot(first, options);
    }

    for (const candidate of found) {
      const result = await runExecutable(
        candidate.command,
        readiness,
        options.readinessTimeoutMs === undefined ? {} : {
          timeoutMs: options.readinessTimeoutMs,
        },
      );
      assertRan(result, `Failed to run ${candidate.command} ${readiness.join(" ")}`);
      if (result.ok) {
        return versionSnapshot(candidate, options);
      }
    }
    return { kind: "unsupported", reason: `${readiness.join(" ")} failed` };
  };
}
