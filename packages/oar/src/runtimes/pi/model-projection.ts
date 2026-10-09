import type { ModelEntry } from "../../contracts/list-models.js";

/** The subset of Pi's `Model` the projection reads; kept structural for tests. */
export interface PiListedModel {
  readonly id: string;
  readonly provider: string;
  readonly name?: string;
  /** Pi's reasoning flag: a model without it runs only the `off` thinking level. */
  readonly reasoning?: boolean;
}

/**
 * The slice of Pi's `ModelRuntime` the lister depends on. `getAvailable()`
 * runs the per-provider availability check (credentials present, OAuth token
 * usable) and returns the usable-now list; it is what `pi --list-models`
 * itself awaits.
 */
export interface PiAvailabilitySource<Model extends PiListedModel = PiListedModel> {
  getAvailable(
    providerId?: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<readonly Model[]>;
}

/** Pi's own thinking-level menu for one model (pi-ai `getSupportedThinkingLevels`), injected so the projection stays pure. */
export type PiThinkingLevelsOf<Model extends PiListedModel> = (model: Model) => readonly string[];

/**
 * Pi model ids are only unique per provider, so the session-facing id is
 * `provider/model`, the same spelling Pi's own `--model` flag accepts.
 *
 * `effortLevels` is pi's thinking-level menu for a reasoning model, exactly
 * as pi derives it (`thinkingLevelMap` drops levels mapped to null and adds
 * `xhigh`/`max` only where mapped; `off` is one of pi's levels and stays
 * where pi offers it), the levels `SessionOptions.effort` accepts on pi. A
 * model without `reasoning` runs only `off` and lists no menu. No
 * `defaultEffort`: pi's default is a settings value clamped per model at
 * session creation, and the session's `effort()` reports it.
 */
export function projectPiModels<Model extends PiListedModel>(
  models: readonly Model[],
  thinkingLevelsOf?: PiThinkingLevelsOf<Model>,
): ModelEntry[] {
  return models.map((model) => {
    const effortLevels = model.reasoning === true && thinkingLevelsOf !== undefined ? thinkingLevelsOf(model) : [];
    return {
      id: `${model.provider}/${model.id}`,
      displayName: model.name === undefined || model.name.trim().length === 0 ? model.id : model.name.trim(),
      ...(effortLevels.length === 0 ? {} : { effortLevels: [...effortLevels] }),
    };
  });
}

