import { spawnSync } from "node:child_process";
import { resolveCommandOnPath } from "../host/windowsCommandResolution.js";
import type { InstallCompatibilityPolicy } from "./contract.js";

export const GROK_STDIO_PROBE_ARGS = ["agent", "stdio", "--help"] as const;
export const GROK_STDIO_TIMEOUT_MS = 5_000;
export const MIN_SUPPORTED_OPENCODE_VERSION = "1.14.30";

export function parseLooseSemver(raw: string | undefined): [number, number, number] | null {
  if (!raw) return null;
  const match = raw.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export function compareLooseSemver(a: string, b: string): number | null {
  const parsedA = parseLooseSemver(a);
  const parsedB = parseLooseSemver(b);
  if (!parsedA || !parsedB) return null;
  for (let index = 0; index < 3; index += 1) {
    if (parsedA[index]! > parsedB[index]!) return 1;
    if (parsedA[index]! < parsedB[index]!) return -1;
  }
  return 0;
}

export function isSupportedOpenCodeVersion(
  version: string,
  min: string = MIN_SUPPORTED_OPENCODE_VERSION,
): boolean {
  const comparison = compareLooseSemver(version, min);
  return comparison !== null && comparison >= 0;
}

function runGrokStdioHelp(command: string): Promise<boolean> {
  return Promise.resolve().then(() => {
    const result = spawnSync(command, [...GROK_STDIO_PROBE_ARGS], {
      encoding: "utf8",
      timeout: GROK_STDIO_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return result.status === 0;
  });
}

export const grokCompatibility: InstallCompatibilityPolicy = async (_version, context) => {
  if (context.hooks.grokStdioGate === false) return null;
  const command = resolveCommandOnPath("grok", context.probe.commandDeps) ?? "grok";
  const probe = context.hooks.grokStdioHelp ?? runGrokStdioHelp;
  try {
    return (await probe(command)) ? null : "incompatible_stdio";
  } catch {
    return "incompatible_stdio";
  }
};

export const opencodeCompatibility: InstallCompatibilityPolicy = async (version, context) => {
  const min =
    context.hooks.opencodeMinVersion === undefined
      ? MIN_SUPPORTED_OPENCODE_VERSION
      : context.hooks.opencodeMinVersion;
  if (min === null) return null;
  return isSupportedOpenCodeVersion(version, min) ? null : "incompatible_version";
};
