import type { InstallAttempt, InstallProbeContext } from "../install/contract.js";
import { resolveClaudeCommand } from "./claudeCommandResolution.js";
import {
  installResolverDependencies,
  versionOfResolvedCommand,
} from "./installProbeHelpers.js";

export function claudeInstallAttempts(
  context: InstallProbeContext,
): readonly InstallAttempt[] {
  return [
    {
      resolution: "command",
      run: async () => {
        const binary = resolveClaudeCommand(installResolverDependencies(context));
        return binary ? versionOfResolvedCommand(binary, context) : null;
      },
    },
  ];
}
