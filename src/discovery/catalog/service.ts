import {
  MODELS_PROBE_BUDGET_MS,
  ModelsProbeError,
  type CatalogTarget,
  type DetectCollectOptions,
  type ModelsProbeFailure,
  type RuntimeDescriptor,
  type RuntimeTimings,
} from "./types.js";
import type { ProviderInfo } from "../../config/model.js";

type CatalogResult =
  | { readonly kind: "absent"; readonly timings: RuntimeTimings }
  | { readonly kind: "present"; readonly descriptor: RuntimeDescriptor };

function timings(detectMs: number, modelsMs: number | null): RuntimeTimings {
  return {
    detectMs,
    modelsMs,
    totalMs: detectMs + (modelsMs ?? 0),
  };
}

async function withinBudget<T>(
  budgetMs: number,
  work: () => Promise<T>,
): Promise<{ readonly ok: true; readonly value: T; readonly ms: number } | {
  readonly ok: false;
  readonly ms: number;
}> {
  const startedAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined = undefined;
  try {
    const result = await Promise.race([
      work().then((value) => ({ kind: "value" as const, value })),
      new Promise<{ readonly kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), budgetMs);
      }),
    ]);
    const ms = performance.now() - startedAt;
    return result.kind === "timeout"
      ? { ok: false, ms }
      : { ok: true, value: result.value, ms };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function failedDescriptor(
  target: CatalogTarget,
  detectMs: number,
): CatalogResult {
  return {
    kind: "present",
    descriptor: {
      runtime: target.id,
      version: "unknown",
      models: [],
      failure: "detect_failed",
      timings: timings(detectMs, null),
    },
  };
}

function modelFailureDescriptor(
  target: CatalogTarget,
  version: string,
  detectMs: number,
  modelsMs: number,
  failure: ModelsProbeFailure,
  providers?: readonly ProviderInfo[],
): CatalogResult {
  return {
    kind: "present",
    descriptor: {
      runtime: target.id,
      version,
      models: [],
      ...(providers !== undefined ? { providers } : {}),
      failure,
      timings: timings(detectMs, modelsMs),
    },
  };
}

async function detectCatalog(
  target: CatalogTarget,
  options: DetectCollectOptions,
): Promise<CatalogResult> {
  const detectStartedAt = performance.now();
  let detected: { readonly version: string } | null = null;
  try {
    detected = await target.detect();
  } catch {
    return failedDescriptor(target, performance.now() - detectStartedAt);
  }
  const detectMs = performance.now() - detectStartedAt;
  if (detected === null) {
    return { kind: "absent", timings: timings(detectMs, null) };
  }

  const modelsStartedAt = performance.now();
  try {
    const collected = await withinBudget(
      options.modelsBudgetMs ?? MODELS_PROBE_BUDGET_MS,
      async () => ({
        models: await target.models(),
        providers: target.providers ? await target.providers() : undefined,
      }),
    );
    if (!collected.ok) {
      return modelFailureDescriptor(
        target,
        detected.version,
        detectMs,
        collected.ms,
        "models_unavailable",
      );
    }

    const { models, providers } = collected.value;
    const hasProviderModels = Boolean(
      providers?.some((provider) => provider.models.length > 0),
    );
    if (models.length === 0 && !hasProviderModels) {
      return modelFailureDescriptor(
        target,
        detected.version,
        detectMs,
        collected.ms,
        "models_unavailable",
        providers,
      );
    }
    return {
      kind: "present",
      descriptor: {
        runtime: target.id,
        version: detected.version,
        models,
        ...(providers !== undefined ? { providers } : {}),
        timings: timings(detectMs, collected.ms),
      },
    };
  } catch (error) {
    const failure =
      error instanceof ModelsProbeError
        ? error.failure
        : "models_unavailable";
    return modelFailureDescriptor(
      target,
      detected.version,
      detectMs,
      performance.now() - modelsStartedAt,
      failure,
    );
  }
}

export async function detectAll(
  targets: readonly CatalogTarget[],
  options: DetectCollectOptions = {},
): Promise<readonly RuntimeDescriptor[]> {
  const results = await Promise.all(
    targets.map((target) => detectCatalog(target, options)),
  );
  return results.flatMap((result) =>
    result.kind === "present" ? [result.descriptor] : [],
  );
}

export async function detectAllRegistered(
  targets: readonly CatalogTarget[],
  registryIds: readonly string[],
  options: DetectCollectOptions = {},
): Promise<readonly RuntimeDescriptor[]> {
  const results = await Promise.all(
    targets.map(async (target) => ({
      id: target.id,
      result: await detectCatalog(target, options),
    })),
  );
  const byRuntime = new Map<string, RuntimeDescriptor>();
  for (const { id, result } of results) {
    byRuntime.set(
      id,
      result.kind === "present"
        ? result.descriptor
        : {
            runtime: id,
            version: "unknown",
            models: [],
            failure: "not_installed",
            timings: result.timings,
          },
    );
  }

  return registryIds.map(
    (runtime): RuntimeDescriptor =>
      byRuntime.get(runtime) ?? {
        runtime,
        version: "unknown",
        models: [],
        failure: "not_installed",
        timings: timings(0, null),
      },
  );
}
