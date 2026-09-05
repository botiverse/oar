import type { ModelEntry, ModelLister } from "../../contracts/list-models.js";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

/** The subset of Pi's `Model` the projection reads; kept structural for tests. */
export interface PiListedModel {
  readonly id: string;
  readonly provider: string;
  readonly name?: string;
}

/**
 * Pi model ids are only unique per provider, so the session-facing id is
 * `provider/model`, the same spelling Pi's own `--model` flag accepts.
 */
export function projectPiModels(models: readonly PiListedModel[]): ModelEntry[] {
  return models.map((model) => ({
    id: `${model.provider}/${model.id}`,
    displayName: model.name === undefined || model.name.trim().length === 0 ? model.id : model.name.trim(),
  }));
}

/**
 * In-process through the bundled SDK: `ModelRegistry.getAvailable()` is the
 * usable-now list (models whose provider has configured auth), as opposed to
 * `getAll()`, which is the full catalog served by the model-catalog facade.
 * Pi keys on provider API keys rather than one login, so "nothing configured"
 * is an `ok` empty list, not `unauthenticated`.
 */
export const piListModels: ModelLister = async (installation) => {
  if (installation.via !== "bundled") {
    return { kind: "unsupported", reason: "pi model listing runs through the bundled Pi SDK" };
  }
  try {
    const runtime = await ModelRuntime.create({ refreshOnCreate: false });
    const registry = new ModelRegistry(runtime);
    return { kind: "ok", models: projectPiModels(registry.getAvailable()) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { kind: "unsupported", reason: `pi SDK could not load its model registry: ${detail}` };
  }
};
