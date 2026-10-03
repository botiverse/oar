import type { ModelEntry, ModelLister } from "../../contracts/list-models.js";
import { cursorEffortParameter } from "./model.js";
import { loadCursorSdk, type CursorSdk, type ModelListItem } from "./sdk.js";

/**
 * Project `Cursor.models.list()` (SDK 1.0.35): `id` is the selector the SDK
 * accepts, the effort menu is the model's reasoning parameter
 * (`cursorEffortParameter`), and the default effort is that parameter's
 * value in the variant the catalog marks `isDefault`.
 */
export function projectCursorModels(models: readonly ModelListItem[]): ModelEntry[] {
  return models.map((model) => {
    const parameter = cursorEffortParameter(model);
    const defaultEffort = parameter === null
      ? undefined
      : model.variants?.find((variant) => variant.isDefault === true)?.params.find((param) => param.id === parameter.id)?.value;
    return {
      id: model.id,
      ...(model.displayName === "" || model.displayName === model.id ? {} : { displayName: model.displayName }),
      ...(parameter === null || parameter.levels.length === 0 ? {} : { effortLevels: parameter.levels }),
      ...(defaultEffort === undefined ? {} : { defaultEffort }),
    };
  });
}

/** Without a credential the SDK refuses before asking (`ConfigurationError`: "API key is required …"). */
function unauthenticated(error: unknown): string | null {
  if (!(error instanceof Error)) {
    return null;
  }
  return error.name === "AuthenticationError" || /api key is required|invalid (?:user )?api key/iu.test(error.message)
    ? error.message
    : null;
}

export function cursorListModelsWith(load: () => Promise<CursorSdk>): ModelLister {
  return async (installation, options = {}) => {
    if (installation.via !== "bundled") {
      return { kind: "unsupported", reason: "cursor model listing needs the bundled @cursor/sdk" };
    }
    const timeoutMs = options.timeoutMs ?? 15_000;
    try {
      const sdk = await load();
      const models = await Promise.race([
        sdk.Cursor.models.list(),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error(`Cursor.models.list() did not answer within ${String(timeoutMs)} ms`));
          }, timeoutMs).unref();
        }),
      ]);
      return { kind: "ok", models: projectCursorModels(models) };
    } catch (error) {
      const detail = unauthenticated(error);
      if (detail !== null) {
        return { kind: "unauthenticated", detail };
      }
      throw new Error("Failed to list Cursor models", { cause: error });
    }
  };
}

export const cursorListModels: ModelLister = cursorListModelsWith(loadCursorSdk);
