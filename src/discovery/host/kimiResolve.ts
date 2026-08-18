import { existsSync } from "node:fs";
import { join } from "node:path";
import { firstLineVersion, runText, which } from "../cli.js";
import { kimiCodeHome } from "./paths.js";
import { resolveSdkPackage } from "./sdkResolve.js";

/** Published, installable SDK identities supported by canonical `kimi`. */
export const KIMI_SDK_CANDIDATES = ["@botiverse/kimi-code-sdk"] as const;

export function resolveKimiSdkVersion(): string | null {
  return resolveSdkPackage(KIMI_SDK_CANDIDATES)?.version ?? null;
}

/** Legacy CLI identity; never falls back to the SDK package. */
export function resolveKimiCliVersion(): string | null {
  const homeBinary = join(kimiCodeHome(), "bin", "kimi");
  if (existsSync(homeBinary)) {
    const result = runText(homeBinary, ["--version"], { timeoutMs: 10_000 });
    return firstLineVersion(result.stdout) ?? firstLineVersion(result.stderr) ?? "unknown";
  }
  const binary = which("kimi");
  if (!binary) return null;
  const result = runText(binary, ["--version"], { timeoutMs: 10_000 });
  return firstLineVersion(result.stdout) ?? firstLineVersion(result.stderr) ?? "unknown";
}
