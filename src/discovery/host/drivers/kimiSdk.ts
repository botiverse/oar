import type { RuntimeDriver } from "../../../backend/runtimeDriver.js";
import { resolveKimiSdkVersion } from "../kimiSdkResolution.js";
import { baseDriver, modelsToInfo } from "../runtimeProbe.js";
import { readKimiModels } from "./kimiCatalog.js";
import type { KimiDriverProbes } from "./kimiDriverProbes.js";

/** Canonical `kimi`: SDK identity only, never a CLI fallback. */
export function kimiDriver(
  probes?: Partial<Pick<KimiDriverProbes, "sdkVersion" | "readModels">>,
): RuntimeDriver {
  const sdkVersion = probes?.sdkVersion ?? resolveKimiSdkVersion;
  const models = probes?.readModels;
  return baseDriver("kimi", {
    detect: async () => {
      const version = sdkVersion();
      return version === null ? null : { version };
    },
    models: async () =>
      models ? models() : modelsToInfo("kimi", readKimiModels()),
  });
}
