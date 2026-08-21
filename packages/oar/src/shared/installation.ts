import { existsSync } from "node:fs";
import type { InstallationProbe, InstallationSnapshot } from "../contracts/installation.js";
import { readExecutableVersion, resolveExecutable, runExecutable } from "./executable/index.js";

// An entry with a path separator is a pinned path: it must exist as given and
// never silently falls back to a different binary. A bare name resolves on PATH.
function usable(entry: string): string | null {
  if (entry.includes("/") || entry.includes("\\")) {
    return existsSync(entry) ? entry : null;
  }
  return resolveExecutable(entry);
}

async function versionSnapshot(command: string): Promise<InstallationSnapshot> {
  const version = await readExecutableVersion(command);
  return version === undefined ? { kind: "available" } : { kind: "available", version };
}

/**
 * An installation probed from an executable: the env var pins one candidate
 * exclusively; otherwise the command name and fallbacks are tried in order and
 * the first usable candidate wins. When readiness args are given, a candidate
 * must run them successfully or the probe moves on to the next one.
 */
export function executableInstallation(
  envVar: string,
  command: string,
  fallbacks: readonly string[] = [],
  readiness?: readonly string[],
): InstallationProbe {
  return async (): Promise<InstallationSnapshot> => {
    const pinned = process.env[envVar];
    const entries = pinned !== undefined && pinned !== "" ? [pinned] : [command, ...fallbacks];

    const found: string[] = [];
    for (const entry of entries) {
      const candidate = usable(entry);
      if (candidate !== null && !found.includes(candidate)) {
        found.push(candidate);
      }
    }

    const [first] = found;
    if (first === undefined) {
      return { kind: "not_found" };
    }
    if (readiness === undefined) {
      return versionSnapshot(first);
    }

    for (const candidate of found) {
      const result = await runExecutable(candidate, readiness);
      if (!result.ok && result.exitCode === null) {
        throw new Error(`Failed to run ${candidate} ${readiness.join(" ")}`);
      }
      if (result.ok) {
        return versionSnapshot(candidate);
      }
    }
    return { kind: "unsupported", reason: `${readiness.join(" ")} failed` };
  };
}
