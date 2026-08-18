import { existsSync } from "node:fs";
import { join } from "node:path";
import { firstLineVersion, runText, type CommandRunner } from "../cli.js";
import { commandAttempts } from "../install/attempts.js";
import type { InstallAttempt, InstallProbeContext } from "../install/types.js";
import { resolveClaudeCommand } from "./claudeResolve.js";
import { resolveCodexBin } from "./codexResolve.js";
import { kimiCodeHome } from "./paths.js";
import { resolveCommandOnPath } from "./windowsResolve.js";

function specialResolverDeps(context: InstallProbeContext): {
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  which: (command: string, env?: NodeJS.ProcessEnv) => string | null;
  exists?: (path: string) => boolean;
  runCommand?: CommandRunner;
} {
  const env = context.commandDeps.env ?? process.env;
  return {
    env,
    ...(context.commandDeps.platform ? { platform: context.commandDeps.platform } : {}),
    which: (command, candidateEnv) =>
      resolveCommandOnPath(command, {
        ...context.commandDeps,
        env: candidateEnv ?? env,
      }),
    ...(context.commandDeps.existsSyncFn
      ? { exists: context.commandDeps.existsSyncFn }
      : {}),
    ...(context.runCommand ? { runCommand: context.runCommand } : {}),
  };
}

function versionOfResolved(binary: string, context: InstallProbeContext): string | null {
  if (context.readVersion) return context.readVersion(binary);
  const run = context.runCommand ?? runText;
  const result = run(binary, ["--version"], { timeoutMs: 10_000 });
  return firstLineVersion(result.stdout) ?? firstLineVersion(result.stderr);
}

export function claudeInstallAttempts(context: InstallProbeContext): readonly InstallAttempt[] {
  return [
    {
      resolution: "command",
      run: async () => {
        const binary = resolveClaudeCommand(specialResolverDeps(context));
        return binary ? versionOfResolved(binary, context) : null;
      },
    },
  ];
}

export function codexInstallAttempts(context: InstallProbeContext): readonly InstallAttempt[] {
  return [
    {
      resolution: "command",
      run: async () => {
        const resolution = resolveCodexBin(specialResolverDeps(context));
        if (!resolution.ok) return null;
        return resolution.version ?? versionOfResolved(resolution.command, context);
      },
    },
  ];
}

export function kimiCliInstallAttempts(context: InstallProbeContext): readonly InstallAttempt[] {
  const homeBinary = join(kimiCodeHome(), "bin", "kimi");
  return [
    {
      resolution: "command",
      run: async () => {
        const exists = context.commandDeps.existsSyncFn ?? existsSync;
        if (!exists(homeBinary)) return null;
        return versionOfResolved(homeBinary, context) ?? "unknown";
      },
    },
    ...commandAttempts(["kimi"])(context),
  ];
}
