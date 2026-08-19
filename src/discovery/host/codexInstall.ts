import type { InstallAttempt, InstallProbeContext } from "../install/contract.js";
import { resolveCodexBin } from "./codexCommandResolution.js";
import {
  installResolverDependencies,
  versionOfResolvedCommand,
} from "./installProbeHelpers.js";

export function codexInstallAttempts(
  context: InstallProbeContext,
): readonly InstallAttempt[] {
  return [
    {
      resolution: "command",
      run: async () => {
        const resolution = resolveCodexBin(installResolverDependencies(context));
        if (!resolution.ok) return null;
        return resolution.version ?? versionOfResolvedCommand(resolution.command, context);
      },
    },
  ];
}
