import type { AccountUsageReader } from "./account-usage.js";
import type { InstallationProbe } from "./installation.js";
import type { StartSession } from "./session.js";

/** One provider-independent runtime adoption unit. */
export interface Runtime {
  readonly id: string;
  readonly installation?: InstallationProbe;
  readonly accountUsage?: AccountUsageReader;
  /** @internal Draft scaffold — hidden from the published surface until the session design settles. */
  readonly session?: StartSession;
}

export function defineRuntime<const T extends Runtime>(runtime: T): T {
  return runtime;
}
