import { resolveSdkPackage } from "./sdkResolve.js";

export const PI_SDK_CANDIDATES = [
  "@earendil-works/pi-coding-agent",
  "@mariozechner/pi-coding-agent",
] as const;

export function resolvePiSdkPackageRoot(): string | null {
  return resolveSdkPackage(PI_SDK_CANDIDATES)?.root ?? null;
}

export function resolvePiSdkVersion(): string | null {
  return resolveSdkPackage(PI_SDK_CANDIDATES)?.version ?? null;
}
