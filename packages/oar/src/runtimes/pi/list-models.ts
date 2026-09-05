import type { ModelEntry, ModelLister } from "../../contracts/list-models.js";
import { createAgentSessionServices } from "@earendil-works/pi-coding-agent";

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
 * In-process through the bundled SDK, built the way `pi --list-models` builds
 * its own runtime: `createAgentSessionServices` loads the extensions under the
 * agent dir and applies their provider registrations to the ModelRuntime
 * before anything is listed. That matters because extensions can be the ONLY
 * source of providers (on exe.dev every listed provider comes from the exe-dev
 * extension; auth.json is empty). A bare `ModelRuntime.create()` sees none of
 * them and prints "no models" while `pi --list-models` prints dozens.
 *
 * The list itself comes from `getAvailable()`, which computes availability on
 * demand. Do NOT read `ModelRegistry.getAvailable()` / `getAvailableSnapshot()`
 * here: that snapshot starts empty and is only filled by an availability
 * refresh (the other half of the 2026-09-05 "no models" bug).
 *
 * Skills, prompt templates, themes, and context files are skipped: they cannot
 * register providers, and listing must not read the project's prompt files.
 * `OAR_PI_AGENT_DIR` pins the agent dir exactly as the session adapter does,
 * so the list and the session see the same providers.
 *
 * Pi keys on provider API keys rather than one login, so "nothing configured"
 * is an `ok` empty list, not `unauthenticated`.
 */
export function createPiListModels(
  createRuntime: (signal: AbortSignal) => Promise<PiAvailabilitySource>,
): ModelLister {
  return async (installation, options = {}) => {
    if (installation.via !== "bundled") {
      return { kind: "unsupported", reason: "pi model listing runs through the bundled Pi SDK" };
    }
    try {
      const signal = AbortSignal.timeout(options.timeoutMs ?? 15_000);
      const runtime = await createRuntime(signal);
      const available = await runtime.getAvailable(undefined, { signal });
      return { kind: "ok", models: projectPiModels(available) };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { kind: "unsupported", reason: `pi SDK could not list available models: ${detail}` };
    }
  };
}

export const piListModels: ModelLister = createPiListModels(async (signal) => {
  const agentDir = process.env.OAR_PI_AGENT_DIR;
  const services = await createAgentSessionServices({
    cwd: process.cwd(),
    ...(agentDir === undefined ? {} : { agentDir }),
    modelRuntimeSignal: signal,
    resourceLoaderOptions: {
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    },
  });
  return services.modelRuntime;
});
