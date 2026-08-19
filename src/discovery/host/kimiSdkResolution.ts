import { resolveSdkPackage } from "./sdkPackageResolution.js";

/** Published, installable SDK identities supported by canonical `kimi`. */
export const KIMI_SDK_CANDIDATES = ["@botiverse/kimi-code-sdk"] as const;

export function resolveKimiSdkVersion(): string | null {
  return resolveSdkPackage(KIMI_SDK_CANDIDATES)?.version ?? null;
}
