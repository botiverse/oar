import type { AccountUsage } from "./account-usage.js";
import type { Installation } from "./installation.js";

/** One provider-independent runtime adoption unit. */
export interface Runtime {
  readonly id: string;
  readonly installation?: Installation;
  readonly accountUsage?: AccountUsage;
}

export function defineRuntime<const T extends Runtime>(runtime: T): T {
  return runtime;
}
