import { existsSync } from "node:fs";
import type { InstallationSnapshot } from "../contracts/installation.js";
import { readExecutableVersion, resolveExecutable, runExecutable } from "./executable/index.js";

// An entry with a path separator is a pinned path: it must exist as given and
// never silently falls back to a different binary. A bare name resolves on PATH.
function usable(entry: string): string | null {
  if (entry.includes("/") || entry.includes("\\")) {
    return existsSync(entry) ? entry : null;
  }
  return resolveExecutable(entry);
}

/** Probe an executable-backed installation over ordered candidates; first usable wins. */
export async function probeExecutableInstallation(
  commands: readonly string[],
  readiness?: { readonly args: readonly string[]; readonly unsupportedReason: string },
): Promise<InstallationSnapshot> {
  const found: string[] = [];
  for (const entry of commands) {
    const command = usable(entry);
    if (command !== null && !found.includes(command)) {
      found.push(command);
    }
  }
  if (found.length === 0) {
    return { kind: "not_found" };
  }

  for (const command of found) {
    if (readiness !== undefined) {
      const result = await runExecutable(command, readiness.args);
      if (!result.ok && result.exitCode === null) {
        throw new Error(`Failed to run ${command} ${readiness.args.join(" ")}`);
      }
      if (!result.ok) {
        continue;
      }
    }
    const version = await readExecutableVersion(command);
    return version === undefined ? { kind: "available" } : { kind: "available", version };
  }

  return { kind: "unsupported", reason: readiness?.unsupportedReason ?? "readiness_check_failed" };
}
