import type { ModelEntry, ModelLister } from "../../contracts/list-models.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** The subset of Pi's `Model` the projection reads; kept structural for tests. */
export interface PiListedModel {
  readonly id: string;
  readonly provider: string;
  readonly name?: string;
}

/**
 * The slice of Pi's `ModelRuntime` the lister depends on. `getAvailable()`
 * runs the per-provider availability check (credentials present, OAuth token
 * usable) and returns the usable-now list; it is what `pi --list-models`
 * itself awaits.
 */
export interface PiAvailabilitySource {
  getAvailable(
    providerId?: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<readonly PiListedModel[]>;
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
 * In-process through the bundled SDK. The runtime is created with
 * `refreshOnCreate: false` (no catalog/network work at construction), and
 * the list comes from `getAvailable()`, which computes availability on
 * demand. Do NOT read `ModelRegistry.getAvailable()` / `getAvailableSnapshot()`
 * here: that snapshot starts empty and is only filled by an availability
 * refresh, so with `refreshOnCreate: false` it reports "no models" even when
 * every provider is configured (bug seen on 2026-09-05).
 *
 * Pi keys on provider API keys rather than one login, so "nothing configured"
 * is an `ok` empty list, not `unauthenticated`.
 */
export function createPiListModels(
  createRuntime: () => Promise<PiAvailabilitySource>,
): ModelLister {
  return async (installation, options = {}) => {
    if (installation.via !== "bundled") {
      return { kind: "unsupported", reason: "pi model listing runs through the bundled Pi SDK" };
    }
    try {
      const runtime = await createRuntime();
      const signal = AbortSignal.timeout(options.timeoutMs ?? 15_000);
      const available = await runtime.getAvailable(undefined, { signal });
      return { kind: "ok", models: projectPiModels(available) };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { kind: "unsupported", reason: `pi SDK could not list available models: ${detail}` };
    }
  };
}

export const piListModels: ModelLister = createPiListModels(async () => {
  const runtime = await ModelRuntime.create({ refreshOnCreate: false });
  return runtime;
});
