import { commandAttempts, sdkAttempts } from "../install/attempts.js";
import {
  grokCompatibility,
  opencodeCompatibility,
} from "../install/policies.js";
import type { InstallTarget } from "../install/types.js";
import {
  claudeInstallAttempts,
  codexInstallAttempts,
  kimiCliInstallAttempts,
} from "./installAttempts.js";
import { resolveKimiSdkVersion } from "./kimiResolve.js";
import { resolvePiSdkVersion } from "./piResolve.js";

function commandTarget(
  runtime: string,
  commands: readonly string[],
  compatibility?: InstallTarget["compatibility"],
): InstallTarget {
  return {
    runtime,
    attempts: commandAttempts(commands),
    ...(compatibility ? { compatibility } : {}),
  };
}

/**
 * Production install registry. It owns install identity, candidate ordering,
 * and compatibility policy; RuntimeDriver owns catalog/drive behavior only.
 */
export function createHostInstallTargets(): readonly InstallTarget[] {
  return [
    { runtime: "claude", attempts: claudeInstallAttempts },
    { runtime: "codex", attempts: codexInstallAttempts },
    commandTarget("grok", ["grok"], grokCompatibility),
    commandTarget("antigravity", ["agy"]),
    commandTarget("copilot", ["copilot"]),
    commandTarget("cursor", ["cursor-agent"]),
    commandTarget("gemini", ["gemini"]),
    { runtime: "kimi", attempts: () => sdkAttempts(resolveKimiSdkVersion) },
    { runtime: "kimi-cli", attempts: kimiCliInstallAttempts },
    commandTarget("opencode", ["opencode"], opencodeCompatibility),
    { runtime: "pi", attempts: () => sdkAttempts(resolvePiSdkVersion) },
  ];
}
