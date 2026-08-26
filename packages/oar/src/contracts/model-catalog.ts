/**
 * Provider-independent model catalog facade — the other half of the provider
 * plane (see {@link ./provider-auth.js}). It lists providers and their models
 * with capabilities and refreshes the remote catalog, but is credential-blind:
 * it reads auth status only to report which providers are usable, never logs
 * in. The built-in implementation wraps Pi's `ModelRegistry`.
 */

/** One provider in the catalog. */
export interface CatalogProvider {
  readonly id: string;
  readonly name: string;
  /** Whether this provider has a usable configured credential. */
  readonly configured: boolean;
}

/** One model with its normalized capabilities. */
export interface CatalogModel {
  readonly id: string;
  readonly providerId: string;
  /** The provider's wire protocol, e.g. `"anthropic-messages"` or `"openai-completions"`. */
  readonly wire: string;
  readonly baseUrl: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  /** Whether the model exposes a reasoning/thinking channel. */
  readonly reasoning: boolean;
  /** Accepted input modalities. */
  readonly input: readonly ("text" | "image")[];
}

export interface CatalogRefreshOptions {
  /** Limit the refresh to these provider ids. */
  readonly providers?: readonly string[];
  /** Allow network access to fetch the remote catalog. */
  readonly allowNetwork?: boolean;
  readonly signal?: AbortSignal;
}

export interface CatalogRefreshResult {
  readonly aborted: boolean;
  /** Per-provider refresh errors, keyed by provider id. */
  readonly errors: ReadonlyMap<string, string>;
}

export interface ModelCatalogFacade {
  /** Every provider that has models, with its usable-auth status. */
  providers(): readonly CatalogProvider[];
  /** Every model, optionally narrowed to one provider. */
  models(providerId?: string): readonly CatalogModel[];
  /** The id of the recommended default model for a provider, if any. */
  defaultModel(providerId: string): string | undefined;
  /** Reload provider catalogs (remote overlay is cached with ETag/Last-Modified). */
  refresh(options?: CatalogRefreshOptions): Promise<CatalogRefreshResult>;
}
