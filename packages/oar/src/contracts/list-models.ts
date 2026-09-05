import type { AvailableInstallation } from "./installation.js";

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
  /** Present when the runtime lists the model but refuses to run it as-is. */
  readonly disabled?: { readonly reason: string };
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
  readonly timeoutMs?: number;
}

export type ModelLister = (
  installation: AvailableInstallation,
  options?: ListModelsOptions,
) => Promise<ListModelsResult>;
