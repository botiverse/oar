import type { InstallTarget } from "../discovery/install/contract.js";
import type { RuntimeDefinition } from "./definition.js";
import type { RuntimeDriver } from "../backend/runtimeDriver.js";

/** Materialise a driver while enforcing the definition's single identity. */
export function createDriverFromDefinition(definition: RuntimeDefinition): RuntimeDriver {
  const driver = definition.createDriver();
  if (driver.id !== definition.id) {
    throw new Error(
      `runtime definition identity mismatch: definition=${definition.id}, driver=${driver.id}`,
    );
  }
  return driver;
}

/** Project the install facet without maintaining a parallel identity list. */
export function createInstallTargetFromDefinition(
  definition: RuntimeDefinition,
): InstallTarget {
  return {
    runtime: definition.id,
    ...definition.install,
  };
}

/** Project the catalog/session facet for a whole adopted runtime registry. */
export function createDriversFromDefinitions(
  definitions: readonly RuntimeDefinition[],
): readonly RuntimeDriver[] {
  return definitions.map((definition) => createDriverFromDefinition(definition));
}

/** Project the install facet for a whole adopted runtime registry. */
export function createInstallTargetsFromDefinitions(
  definitions: readonly RuntimeDefinition[],
): readonly InstallTarget[] {
  return definitions.map((definition) => createInstallTargetFromDefinition(definition));
}
