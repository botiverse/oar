import { firstLineVersion, runText, type CommandRunner } from "../cli.js";
import type { InstallProbeContext } from "../install/contract.js";
import { resolveCommandOnPath } from "./windowsCommandResolution.js";

export interface SpecialCommandResolverDependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly which: (command: string, env?: NodeJS.ProcessEnv) => string | null;
  readonly exists?: (path: string) => boolean;
  readonly runCommand?: CommandRunner;
}

/** Adapt the install probe boundary to host command resolvers. */
export function installResolverDependencies(
  context: InstallProbeContext,
): SpecialCommandResolverDependencies {
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

/** Read the version of the exact binary selected by a special resolver. */
export function versionOfResolvedCommand(
  binary: string,
  context: InstallProbeContext,
): string | null {
  if (context.readVersion) return context.readVersion(binary);
  const run = context.runCommand ?? runText;
  const result = run(binary, ["--version"], { timeoutMs: 10_000 });
  return firstLineVersion(result.stdout) ?? firstLineVersion(result.stderr);
}
