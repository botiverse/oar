import type { Installation, InstallationSnapshot } from "../../contracts/installation.js";
import { resolveExecutable, runExecutable } from "../../shared/executable/index.js";
import type { ExecutableRunner } from "../../shared/executable/index.js";

export interface ClaudeInstallationDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly resolve?: (command: string) => string | null;
  readonly run?: ExecutableRunner;
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
      if (command === null) return { kind: "not_found" };

      const result = await (dependencies.run ?? runExecutable)(command, ["--version"], {
        env,
        timeoutMs: 5_000,
      });
      if (!result.ok) throw new Error("Failed to probe the Claude installation version");
      const version = result.stdout.trim().split(/\r?\n/u)[0];
      return {
        kind: "available",
        ...(version === undefined || version.length === 0 ? {} : { version }),
      };
    },
  };
}
