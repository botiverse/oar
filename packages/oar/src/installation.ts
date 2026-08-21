import path from "node:path";
import { existsSync } from "node:fs";
import type { Installation, InstallationSnapshot } from "./contracts/installation.js";
import { resolveExecutable, runExecutable } from "./shared/executable/index.js";

interface ReadinessProbe {
  readonly args: readonly string[];
  readonly unsupportedReason: string;
}

export interface ExecutableInstallationDefinition {
  readonly label: string;
  readonly command: string;
  readonly explicit?: string | undefined;
  readonly fallbacks?: readonly string[];
  readonly readiness?: ReadinessProbe;
}

function candidates(definition: ExecutableInstallationDefinition): readonly string[] {
  const explicit = definition.explicit?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    const command = path.isAbsolute(explicit) ? explicit : resolveExecutable(explicit);
    return command !== null && existsSync(command) ? [command] : [];
  }

  const found: string[] = [];
  const onPath = resolveExecutable(definition.command);
  if (onPath !== null) {
    found.push(onPath);
  }
  for (const command of definition.fallbacks ?? []) {
    if (existsSync(command) && !found.includes(command)) {
      found.push(command);
    }
  }
  return found;
}

function version(stdout: string): string | undefined {
  const value = stdout.trim().split(/\r?\n/u)[0];
  return value === undefined || value.length === 0 ? undefined : value;
}

export function createExecutableInstallation(
  definition: ExecutableInstallationDefinition,
): Installation {
  return {
    async probe(): Promise<InstallationSnapshot> {
      const available = candidates(definition);
      if (available.length === 0) {
        return { kind: "not_found" };
      }

      for (const command of available) {
        if (definition.readiness !== undefined) {
          const readiness = await runExecutable(command, definition.readiness.args);
          if (!readiness.ok && readiness.exitCode === null) {
            throw new Error(`Failed to probe the ${definition.label} readiness surface`);
          }
          if (!readiness.ok) {
            continue;
          }
        }

        const result = await runExecutable(command, ["--version"]);
        if (!result.ok && result.exitCode === null) {
          throw new Error(`Failed to probe the ${definition.label} installation version`);
        }
        const value = result.ok ? version(result.stdout) : undefined;
        return {
          kind: "available",
          ...(value === undefined ? {} : { version: value }),
        };
      }

      return {
        kind: "unsupported",
        reason: definition.readiness?.unsupportedReason ?? "readiness_check_failed",
      };
    },
  };
}
