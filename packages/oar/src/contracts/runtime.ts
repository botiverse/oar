import type { InventoryResult, RuntimeInventories } from "./inventory.js";
import type { AccountUsageReader } from "./account-usage.js";
import type { InstallationProbe } from "./installation.js";
import type { ModelLister } from "./list-models.js";
import type { RuntimeBrand } from "./brand.js";
import type { StartSession } from "./session.js";

/** One provider-independent runtime adoption unit. */
export interface Runtime extends RuntimeInventories {
  readonly id: string;
  readonly brand: RuntimeBrand;
  readonly session: StartSession; // the core capability: a runtime without sessions is not usable
  readonly installation?: InstallationProbe;
  readonly accountUsage?: AccountUsageReader;
  readonly listModels?: ModelLister;
}

async function unsupported(): Promise<InventoryResult<never>> {
  await Promise.resolve();
  return {
    kind: "unsupported",
    code: "transport_unavailable",
    reason: "The selected runtime interface does not expose this inventory",
  };
}

export function defineRuntime<const T extends Omit<Runtime, keyof RuntimeInventories | "brand"> & Partial<RuntimeInventories> & { readonly brand?: RuntimeBrand }>(runtime: T): T & RuntimeInventories & { readonly brand: RuntimeBrand } {
  return { skills: unsupported, mcpServers: unsupported, tools: unsupported, ...runtime, brand: runtime.brand ?? { name: runtime.id, icon: null } };
}
