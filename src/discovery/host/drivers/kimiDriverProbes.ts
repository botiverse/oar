import type { ModelInfo } from "../../../config/model.js";

/** Injectable Kimi seams shared only by the two identity-specific drivers. */
export interface KimiDriverProbes {
  readonly sdkVersion: () => string | null;
  readonly cliVersion: () => string | null;
  readonly readModels: () => readonly ModelInfo[];
}
