import { existsSync } from "node:fs";
import { join } from "node:path";
import { commandAttempts } from "../install/attempts.js";
import type { InstallAttempt, InstallProbeContext } from "../install/contract.js";
import { versionOfResolvedCommand } from "./installProbeHelpers.js";
import { kimiCodeHome } from "./runtimePaths.js";

export function kimiCliInstallAttempts(
  context: InstallProbeContext,
): readonly InstallAttempt[] {
  const homeBinary = join(kimiCodeHome(), "bin", "kimi");
  return [
    {
      resolution: "command",
      run: async () => {
        const exists = context.commandDeps.existsSyncFn ?? existsSync;
        if (!exists(homeBinary)) return null;
        return versionOfResolvedCommand(homeBinary, context) ?? "unknown";
      },
    },
    ...commandAttempts(["kimi"])(context),
  ];
}
