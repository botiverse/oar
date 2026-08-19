import { existsSync } from "node:fs";
import { join } from "node:path";
import { firstLineVersion, runText, which } from "../cli.js";
import { kimiCodeHome } from "./runtimePaths.js";

/** Resolve only the legacy CLI identity; never fall back to the SDK package. */
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
