import type { Installation, InstallationSnapshot } from "../../contracts/installation.js";
import { resolveExecutable, runExecutable } from "../../shared/executable/index.js";
import type { ExecutableRunner } from "../../shared/executable/index.js";

export interface ClaudeInstallationDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly resolve?: (command: string) => string | null;
  readonly run?: ExecutableRunner;
  readonly now?: () => number;
}

export function createClaudeInstallation(
  dependencies: ClaudeInstallationDependencies = {},
): Installation {
  return {
    async probe(): Promise<InstallationSnapshot> {
      const env = dependencies.env ?? process.env;
      const resolve = dependencies.resolve ?? resolveExecutable;
      const explicit = env.CLAUDE_BIN?.trim();
      const command = explicit === undefined || explicit.length === 0
        ? resolve("claude")
        : resolve(explicit);
      const observedAt = new Date((dependencies.now ?? Date.now)()).toISOString();
      if (command === null) return { runtime: "claude", state: "not_installed", observedAt };
      const result = await (dependencies.run ?? runExecutable)(command, ["--version"], {
        env,
        timeoutMs: 5_000,
      });
      if (!result.ok) {
        return {
          runtime: "claude",
          state: "detect_failed",
          observedAt,
          diagnostic: { code: "version_probe_failed" },
        };
      }
      const version = result.stdout.trim().split(/\r?\n/u)[0];
      return {
        runtime: "claude",
        state: "available",
        observedAt,
        source: explicit === undefined || explicit.length === 0 ? "path" : "explicit",
        ...(version === undefined || version.length === 0 ? {} : { version }),
      };
    },
  };
}
