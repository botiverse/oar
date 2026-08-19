import type { RuntimeDriver } from "../../../backend/runtimeDriver.js";
import { resolveKimiCliVersion } from "../kimiCliResolution.js";
import { baseDriver, modelsToInfo } from "../runtimeProbe.js";
import { readKimiModels } from "./kimiCatalog.js";
import type { KimiDriverProbes } from "./kimiDriverProbes.js";

/** Legacy `kimi-cli`: CLI identity only, never an SDK fallback. */
export function kimiCliDriver(
  probes?: Partial<Pick<KimiDriverProbes, "cliVersion" | "readModels">>,
): RuntimeDriver {
  const cliVersion = probes?.cliVersion ?? resolveKimiCliVersion;
  const models = probes?.readModels;
  return baseDriver("kimi-cli", {
    detect: async () => {
      const version = cliVersion();
      return version === null ? null : { version };
    },
    models: async () =>
      models ? models() : modelsToInfo("kimi-cli", readKimiModels()),
  });
}
