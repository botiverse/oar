import type {
  CatalogModel,
  CatalogProvider,
  CatalogRefreshOptions,
  CatalogRefreshResult,
  ModelCatalogFacade,
} from "../../contracts/model-catalog.js";
import { ModelRegistry, ModelRuntime, resolveCliModel } from "@earendil-works/pi-coding-agent";

type PiModel = ReturnType<ModelRegistry["getAll"]>[number];

function toCatalogModel(model: PiModel): CatalogModel {
  return {
    id: model.id,
    providerId: model.provider,
    wire: model.api,
    baseUrl: model.baseUrl,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    input: [...model.input],
  };
}

class PiModelCatalog implements ModelCatalogFacade {
  readonly #runtime: ModelRuntime;
  readonly #registry: ModelRegistry;

  constructor(runtime: ModelRuntime) {
    this.#runtime = runtime;
    this.#registry = new ModelRegistry(runtime);
  }

  providers(): readonly CatalogProvider[] {
    const ids = new Set(this.#registry.getAll().map((model) => model.provider));
    return [...ids].map((id) => ({
      id,
      name: this.#registry.getProviderDisplayName(id),
      configured: this.#registry.getProviderAuthStatus(id).configured,
    }));
  }

  models(providerId?: string): readonly CatalogModel[] {
    const all = this.#registry.getAll();
    const scoped = providerId === undefined ? all : all.filter((model) => model.provider === providerId);
    return scoped.map((model) => toCatalogModel(model));
  }

  defaultModel(providerId: string): string | undefined {
    const resolved = resolveCliModel({ modelRuntime: this.#runtime, cliProvider: providerId });
    if (resolved.model !== undefined) {
      return resolved.model.id;
    }
    // Pi's curated per-provider default (`defaultModelPerProvider`) is not part
    // of its public export, and `resolveCliModel` only resolves providers with
    // usable auth; fall back to the first catalogued model for the provider.
    return this.#registry.getAll().find((model) => model.provider === providerId)?.id;
  }

  async refresh(options: CatalogRefreshOptions = {}): Promise<CatalogRefreshResult> {
    const result = await this.#registry.refresh({
      allowNetwork: options.allowNetwork ?? true,
      ...(options.providers === undefined ? {} : { providers: options.providers }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const errors = new Map<string, string>();
    for (const [providerId, error] of result.errors) {
      errors.set(providerId, error.message);
    }
    return { aborted: result.aborted, errors };
  }
}

export interface PiModelCatalogOptions {
  /** Path to Pi's `auth.json`; defaults to Pi's `~/.pi/agent/auth.json`. */
  readonly authPath?: string;
  /** Path to Pi's `models.json`; `null` disables the static config. */
  readonly modelsPath?: string | null;
}

/** Create a {@link ModelCatalogFacade} backed by Pi's `ModelRegistry`. */
export async function createPiModelCatalog(options: PiModelCatalogOptions = {}): Promise<ModelCatalogFacade> {
  const runtime = await ModelRuntime.create({
    ...(options.authPath === undefined ? {} : { authPath: options.authPath }),
    ...(options.modelsPath === undefined ? {} : { modelsPath: options.modelsPath }),
    refreshOnCreate: false,
  });
  return new PiModelCatalog(runtime);
}
