import type { AccountUsageReader } from "./account-usage.js";
import type { InstallationProbe } from "./installation.js";

/** One provider-independent runtime adoption unit. */
export interface Runtime {
  readonly id: string;
  readonly installation?: InstallationProbe;
  readonly accountUsage?: AccountUsageReader;
}

export function defineRuntime<const T extends Runtime>(runtime: T): T {
  return runtime;
}
