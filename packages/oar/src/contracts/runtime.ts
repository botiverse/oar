import type { AuthStatusReader, RuntimeLogin, RuntimeLogout } from "./login.js";
import type { InstallLine, InstallPlanner, Installer } from "./install.js";
import type { InventoryResult, RuntimeInventories } from "./inventory.js";
import type { UpdateChecker, Upgrader } from "./update.js";
import type { AccountUsageReader } from "./account-usage.js";
import type { InstallationProbe } from "./installation.js";
import type { ModelLister } from "./list-models.js";
import type { RuntimeBrand } from "./brand.js";
import type { StartSession } from "./session.js";

/** The `SessionOptions` a runtime can refuse at open. */
export type RefusableSessionOption = "systemPrompt" | "appendSystemPrompt" | "env" | "mcpServers" | "disallowedTools" | "launchArgs" | "serviceTier";

/**
 * The options a runtime refuses when they are given (`env`, `mcpServers`, `disallowedTools`, `launchArgs`: a
 * non-empty one), each with the reason `session()` rejects with, in the message of an
 * `UnsupportedOptionError` naming the option. Unlisted options can still have value-specific refusals (for example,
 * a tool name the native filter cannot disable); see the runtime page.
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
  /** Read only: what `install` would run here, or why it would run nothing. Present exactly when `install` is. */
  readonly installPlan?: InstallPlanner;
  /**
   * Runs the runtime's own installer when `installation` finds none, judged by
   * `installation` afterwards; changes the machine, so only on the host's
   * explicit call. Absent when there is nothing to install (a bundled SDK).
   */
  readonly install?: Installer;
  /**
   * Declared by a runtime whose vendor ships parallel release lines of one
   * command (opencode: `v1`, `v2`), so a host offers the choice before
   * planning: `installPlan` and `install` take one as `options.line` and
   * answer `line_required` without it. Absent for a runtime with one line.
   */
  readonly installLines?: readonly InstallLine[];
  readonly accountUsage?: AccountUsageReader;
  readonly listModels?: ModelLister;
  /** Read only: the version the runtime's own updater would install. */
  readonly checkUpdate?: UpdateChecker;
  /** Runs the runtime's own updater; changes the machine, so only on the host's explicit call. */
  readonly upgrade?: Upgrader;
  /** Signs the runtime in through its own login; changes the machine's credentials, so only on the host's explicit call. */
  readonly login?: RuntimeLogin;
  /** Signs the runtime out through its own logout, confirmed by its status query; changes the machine's credentials, so only on the host's explicit call. */
  readonly logout?: RuntimeLogout;
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
