import type { AvailableInstallation } from "./installation.js";
import type { SessionOptions } from "./session-options.js";

/**
 * One model the runtime will accept as a session `model` right now.
 *
 * `id` is the selector to pass back to the runtime (a Claude alias such as
 * `sonnet`, a Codex slug, a Grok model id, or a Pi `provider/model` pair).
 * `resolvedId` is present only when the runtime distinguishes the selector
 * from the concrete model it resolves to today.
 */
export interface ModelEntry {
  readonly id: string;
  readonly resolvedId?: string;
  readonly displayName?: string;
  /** Runtime-enumerated reasoning effort menu; omitted when not exposed. */
  readonly effortLevels?: readonly string[];
  readonly defaultEffort?: string;
  /** Native service-tier menu; the explicit opt-out `default` is not a tier. */
  readonly serviceTiers?: readonly string[];
  /** Native catalog default, when the runtime reports one. */
  readonly defaultServiceTier?: string;
  /** Present when the runtime lists the model but refuses to run it as-is. */
  readonly disabled?: { readonly reason: string };
  /**
   * The model a session uses when no `model` is set, where the runtime says
   * so: codex's configured model (else its catalog `isDefault`), a new ACP
   * session's current model (grok, kimi, antigravity), pi's saved default.
   * Configuration is read for `ListModelsOptions.cwd`. Absent when the runtime
   * cannot say (claude: its settings can pick a model its list does not
   * reflect; cursor, opencode); OAR never picks one.
   */
  readonly default?: true;
  /**
   * The provider serving this model, for runtimes with several (pi, opencode),
   * so a host can group or label entries without parsing `id`.
   */
  readonly provider?: { readonly id: string; readonly displayName?: string };
}

/**
 * Usable-now list, not a static catalog: what comes back depends on the
 * login state, plan, provider configuration, and installed CLI version at
 * the moment of the call, so callers must re-query rather than cache.
 *
 * `unauthenticated` is deliberately distinct from `ok` with an empty list:
 * a runtime that is installed and lists nothing is a different state from a
 * runtime that refuses to answer until someone logs in.
 */
export type ListModelsResult =
  | { readonly kind: "ok"; readonly models: readonly ModelEntry[] }
  | { readonly kind: "unauthenticated"; readonly detail?: string }
  | { readonly kind: "unsupported"; readonly reason: string };

export interface ListModelsOptions {
  /** Same overlay as sessions: strings override, null removes, and the host is untouched. */
  readonly env?: SessionOptions["env"];
  /**
   * The directory a session would run in, resolved against the host's cwd,
   * which is also the default. Project configuration there can change the
   * list, its providers and `default`, so a host with several workspaces
   * should list per workspace. Listing starts the runtime there the way a
   * session would, so like the inventory readers it can run that workspace's
   * code (pi loads the project's extensions): do not list in a directory you
   * do not trust. cursor, pi-durable and morph list without one.
   */
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export type ModelLister = (
  installation: AvailableInstallation,
  options?: ListModelsOptions,
) => Promise<ListModelsResult>;
