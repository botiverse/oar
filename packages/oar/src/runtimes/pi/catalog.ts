import type {
  CatalogModel,
  CatalogProvider,
  CatalogRefreshOptions,
  CatalogRefreshResult,
  ModelCatalogFacade,
} from "../../contracts/model-catalog.js";
import { ModelRegistry, type ModelRuntime, resolveCliModel } from "@earendil-works/pi-coding-agent";
import { piFacadeRuntime, type PiModelRuntimePaths } from "./facade-runtime.js";

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

/**
 * The providers with a key or login in `auth.json`, read from the file
 * alone: no credential is resolved or refreshed, so no network. Pi counts
 * these as configured only from its availability snapshot, which a runtime
 * created with `refreshOnCreate: false` leaves empty until a refresh (#291).
 */
async function storedProviders(runtime: ModelRuntime): Promise<ReadonlySet<string>> {
  const credentials = await runtime.listCredentials();
  return new Set(credentials.map((credential) => credential.providerId));
}

class PiModelCatalog implements ModelCatalogFacade {
  readonly #runtime: ModelRuntime;
  readonly #registry: ModelRegistry;
  #stored: ReadonlySet<string>;

  constructor(runtime: ModelRuntime, stored: ReadonlySet<string>) {
    this.#runtime = runtime;
    this.#registry = new ModelRegistry(runtime);
    this.#stored = stored;
  }

  providers(): readonly CatalogProvider[] {
    const ids = new Set(this.#registry.getAll().map((model) => model.provider));
    return [...ids].map((id) => ({
      id,
      name: this.#registry.getProviderDisplayName(id),
      configured: this.#stored.has(id) || this.#registry.getProviderAuthStatus(id).configured,
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
    this.#stored = await storedProviders(this.#runtime);
    const errors = new Map<string, string>();
    for (const [providerId, error] of result.errors) {
      errors.set(providerId, error.message);
    }
    return { aborted: result.aborted, errors };
  }
}

/** `auth.json` and `models.json` default into the agent dir sessions use. */
export type PiModelCatalogOptions = PiModelRuntimePaths;

/** Create a {@link ModelCatalogFacade} backed by Pi's `ModelRegistry`. */
export async function createPiModelCatalog(options: PiModelCatalogOptions = {}): Promise<ModelCatalogFacade> {
  const runtime = await piFacadeRuntime(options, { refreshOnCreate: false });
  return new PiModelCatalog(runtime, await storedProviders(runtime));
}
