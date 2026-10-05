import type { AuthStatusReader, RuntimeLogin } from "./login.js";
import type { InventoryResult, RuntimeInventories } from "./inventory.js";
import type { UpdateChecker, Upgrader } from "./update.js";
import type { AccountUsageReader } from "./account-usage.js";
import type { InstallationProbe } from "./installation.js";
import type { ModelLister } from "./list-models.js";
import type { RuntimeBrand } from "./brand.js";
import type { StartSession } from "./session.js";

/** The `SessionOptions` a runtime can refuse at open. */
export type RefusableSessionOption = "systemPrompt" | "appendSystemPrompt" | "env";

/**
 * The options a runtime refuses when they are given (`env`: a non-empty
 * one), each with the reason `session()` rejects with, as the message of an
 * `UnsupportedOptionError` naming the option. Options it does not list, and
 * every option when the map is absent, are accepted.
 */
export type RefusedSessionOptions = Readonly<Partial<Record<RefusableSessionOption, string>>>;

/** One provider-independent runtime adoption unit. */
export interface Runtime extends RuntimeInventories {
  readonly id: string;
  readonly brand: RuntimeBrand;
  readonly session: StartSession; // the core capability: a runtime without sessions is not usable
  /**
   * Declared before any session opens, so a host leaves a refused option out
   * without knowing runtimes by name. `session()` checks the same map, so a
   * declared option is always refused (an `UnsupportedOptionError`) and a
   * refused one always declared. A refusal only the runtime can decide at
   * open (kimi's directory for a resume) is not declared here but is the
   * same error.
   */
  readonly refusedSessionOptions?: RefusedSessionOptions;
  readonly installation?: InstallationProbe;
  readonly accountUsage?: AccountUsageReader;
  readonly listModels?: ModelLister;
  /** Read only: the version the runtime's own updater would install. */
  readonly checkUpdate?: UpdateChecker;
  /** Runs the runtime's own updater; changes the machine, so only on the host's explicit call. */
  readonly upgrade?: Upgrader;
  /** Signs the runtime in through its own login; changes the machine's credentials, so only on the host's explicit call. */
  readonly login?: RuntimeLogin;
  /** Read only: whether the runtime is signed in, from its local status query. */
  readonly authStatus?: AuthStatusReader;
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
