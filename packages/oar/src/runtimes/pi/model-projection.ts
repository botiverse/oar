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
  /** Pi's provider record, for its display name (the one `ModelRegistry.getProviderDisplayName` reads). */
  getProvider?(providerId: string): { readonly name?: string } | undefined;
  /** The default saved in pi's settings (`defaultProvider` / `defaultModel`), when one is. */
  readonly savedDefault?: { readonly provider: string; readonly id: string };
}

/** What the listing adds from pi beyond the models themselves. */
export interface PiModelContext {
  readonly providerName?: (providerId: string) => string | undefined;
  readonly savedDefault?: { readonly provider: string; readonly id: string };
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
 *
 * `provider` is the model's provider id with pi's display name for it.
 * `default` marks the default saved in pi's settings when it is listed; with
 * none saved, pi picks the first available model at session creation, which
 * OAR does not guess. pi reads those settings globally and from the project
 * at the host's own cwd, so a session opened in another project can start on
 * that project's default instead.
 */
export function projectPiModels<Model extends PiListedModel>(
  models: readonly Model[],
  thinkingLevelsOf?: PiThinkingLevelsOf<Model>,
  context: PiModelContext = {},
): ModelEntry[] {
  return models.map((model) => {
    const effortLevels = model.reasoning === true && thinkingLevelsOf !== undefined ? thinkingLevelsOf(model) : [];
    const providerName = context.providerName?.(model.provider)?.trim();
    const isDefault = context.savedDefault?.provider === model.provider && context.savedDefault.id === model.id;
    return {
      id: `${model.provider}/${model.id}`,
      displayName: model.name === undefined || model.name.trim().length === 0 ? model.id : model.name.trim(),
      ...(effortLevels.length === 0 ? {} : { effortLevels: [...effortLevels] }),
      // pi uses the id as a provider's name when it has none of its own: no displayName then.
      provider: { id: model.provider, ...(providerName === undefined || providerName.length === 0 || providerName === model.provider ? {} : { displayName: providerName }) },
      ...(isDefault ? { default: true as const } : {}),
    };
  });
}

