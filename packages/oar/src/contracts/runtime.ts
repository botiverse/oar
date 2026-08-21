import type { AccountUsageReader } from "./account-usage.js";
import type { InstallationProbe } from "./installation.js";
import type { StartSession } from "./session.js";

/** One provider-independent runtime adoption unit. */
export interface Runtime {
  readonly id: string;
  readonly session: StartSession; // the core capability — a runtime without sessions is not usable
  readonly installation?: InstallationProbe;
  readonly accountUsage?: AccountUsageReader;
}

export function defineRuntime<const T extends Runtime>(runtime: T): T {
  return runtime;
}
