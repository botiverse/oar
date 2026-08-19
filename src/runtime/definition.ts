import type { InstallTarget } from "../discovery/install/contract.js";
import type { RuntimeDriver } from "../backend/runtimeDriver.js";

/** Install detection owned by one runtime, without a second copy of its id. */
export type RuntimeInstallDefinition = Omit<InstallTarget, "runtime">;

/**
 * One runtime's complete host-side definition.
 *
 * Consumers adopt this root object once, then use only the facet they need:
 * install detection today, catalog detection next, and session driving later.
 * Narrow feature contracts remain internal test seams; they are not separate
 * runtime registries for consumers to assemble by hand.
 */
export interface RuntimeDefinition {
  readonly id: string;
  readonly install: RuntimeInstallDefinition;
  createDriver(): RuntimeDriver;
}
