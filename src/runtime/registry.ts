import {
  createDriversFromDefinitions,
  createInstallTargetsFromDefinitions,
} from "./projections.js";
import type { InstallTarget } from "../discovery/install/contract.js";
import type { RuntimeDefinition } from "./definition.js";
import type { RuntimeDriver } from "../backend/runtimeDriver.js";
import commandRuntimeDefinitions from "./definitions/command-runtimes.js";
import sdkRuntimeDefinitions from "./definitions/sdk-runtimes.js";
import specialRuntimeDefinitions from "./definitions/special-runtimes.js";

/**
 * The one canonical host-runtime registry.
 *
 * Each runtime owns one definition module. Small groups keep this composition
 * readable without turning the registry into a dependency hub.
 */
export function createHostRuntimeDefinitions(): readonly RuntimeDefinition[] {
  return [
    specialRuntimeDefinitions.claude,
    specialRuntimeDefinitions.codex,
    commandRuntimeDefinitions.grok,
    commandRuntimeDefinitions.antigravity,
    commandRuntimeDefinitions.copilot,
    commandRuntimeDefinitions.cursor,
    commandRuntimeDefinitions.gemini,
    sdkRuntimeDefinitions.kimi,
    specialRuntimeDefinitions.kimiCli,
    commandRuntimeDefinitions.opencode,
    sdkRuntimeDefinitions.pi,
  ];
}

/** Catalog/session view derived from the canonical runtime definitions. */
export function createHostDrivers(): readonly RuntimeDriver[] {
  return createDriversFromDefinitions(createHostRuntimeDefinitions());
}

/** Install-detection view derived from the same runtime definitions. */
export function createHostInstallTargets(): readonly InstallTarget[] {
  return createInstallTargetsFromDefinitions(createHostRuntimeDefinitions());
}
