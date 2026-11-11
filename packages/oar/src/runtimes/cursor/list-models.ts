import { refuseReaderEnvironment } from "../../shared/refuse-environment.js";
import type { ModelEntry, ModelLister } from "../../contracts/list-models.js";
import { cursorEffortParameter } from "./model.js";
import { callRedaction, cursorSdkAccess, type CursorSdkLease, type CursorSdkSource } from "./access.js";
import type { CursorSdk, ModelListItem } from "./sdk.js";

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

async function listWithin(sdk: CursorSdk, timeoutMs: number): Promise<readonly ModelListItem[]> {
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    deadline.reject(new Error(`Cursor.models.list() did not answer within ${String(timeoutMs)} ms`));
  }, timeoutMs);
  timer.unref();
  try {
    const models = await Promise.race([sdk.Cursor.models.list(), deadline.promise]);
    return models;
  } finally {
    clearTimeout(timer);
  }
}

/** `Cursor.models.list()`; in subprocess mode in a child of its own with `env`, stopped when the call ends. */
export function cursorListModelsWith(source: CursorSdkSource): ModelLister {
  const access = cursorSdkAccess(source);
  return async (installation, options = {}) => {
    if (access.execution === "in_process") { refuseReaderEnvironment(options.env, "cursor model listing runs in the host process"); }
    if (installation.via !== "bundled") {
      return { kind: "unsupported", reason: "cursor model listing needs the bundled @cursor/sdk" };
    }
    // Its answer and errors (with their cause, and a child's stderr tail) go through the call's credentials.
    const clean = callRedaction(options.env);
    let lease: CursorSdkLease | null = null;
    try {
      lease = await access.lease(options.env);
      const models = await listWithin(lease.sdk, options.timeoutMs ?? 15_000);
      return { kind: "ok", models: projectCursorModels(models) };
    } catch (error) {
      const detail = unauthenticated(error);
      if (detail !== null) {
        return clean({ kind: "unauthenticated", detail });
      }
      throw clean(new Error("Failed to list Cursor models", { cause: error }));
    } finally {
      await lease?.release();
    }
  };
}
