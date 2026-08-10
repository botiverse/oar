/**
 * Host-side detection: which runtimes are installed + models(+options).
 * oar never names "computer" — currency is RuntimeDescriptor[].
 */

import type { RuntimeDriver } from "../backend/trait.js";
import type { ModelInfo, ProviderInfo } from "../config/model.js";

/**
 * Why a runtime is not offering models. CLOSED set — never a raw exception string.
 *
 * Three product states for testbed/oar acceptance (R3) must stay distinguishable:
 * - not_installed — binary/driver absent
 * - needs_login — installed but auth required before model list works
 * - models_unavailable / detect_failed — installed-ish but probe failed without a clean login signal
 */
export type DetectFailure =
  | "models_unavailable" // detect() ok, models() empty/failed (not a clean login signal)
  | "detect_failed" // detect() threw — installed-ness UNKNOWN, not "absent"
  | "not_installed" // known registry runtime, host detect returned absent
  | "needs_login"; // installed; models probe says sign-in required

/**
 * Per-runtime phase timings (ms). First-class on every live collection record.
 * Does not alter the four DetectFailure states.
 */
export interface RuntimeTimings {
  readonly detectMs: number;
  /** null when models() was not invoked (detect failed / absent). */
  readonly modelsMs: number | null;
  readonly totalMs: number;
}

/** Soft budget for models(); exceeded → models_unavailable (typed), not hang-the-sweep. */
export const MODELS_PROBE_BUDGET_MS = 5_000;

/**
 * Optional probe trace for --debug. Default empty so the hot path stays quiet
 * and free of raw CLI dumps (which may contain credential-shaped material).
 */
export interface ProbeTraceEvent {
  readonly phase: "detect" | "models";
  readonly command?: string;
  readonly exitCode?: number | null;
  readonly durationMs: number;
  readonly stdoutExcerpt?: string;
  readonly stderrExcerpt?: string;
  readonly note?: string;
}

/**
 * Drivers throw this from models() when the CLI is present but auth-gated.
 * Must not be collapsed into empty-models + failure:undefined (looks "healthy").
 */
export class ModelsProbeError extends Error {
  readonly failure: DetectFailure;
  constructor(failure: DetectFailure, message: string) {
    super(message);
    this.name = "ModelsProbeError";
    this.failure = failure;
  }
}

export interface RuntimeDescriptor {
  readonly runtime: string;
  readonly version: string;
  /** Display label for UI (optional; falls back to runtime id). */
  readonly label?: string;
  /** Flat model list when there is no provider axis. */
  readonly models: readonly ModelInfo[];
  /** Provider axis (e.g. pi). When present and non-empty, schema uses provider→model. */
  readonly providers?: readonly ProviderInfo[];
  readonly failure?: DetectFailure;
  /** Always present on live detect paths; offline fixtures may omit. */
  readonly timings?: RuntimeTimings;
  /**
   * In-process / non-CLI capability (pi is SDK-only in oar for now).
   * Optional; not required for the four failure states.
   */
  readonly inProcess?: boolean;
  /** Only populated when detect is run with debug tracing enabled. */
  readonly debug?: readonly ProbeTraceEvent[];
}

export type DetectCollectOptions = {
  /** Soft budget for models() phase. Default MODELS_PROBE_BUDGET_MS. */
  readonly modelsBudgetMs?: number;
};

function nowMs(): number {
  return performance.now();
}

function timingsOf(detectMs: number, modelsMs: number | null): RuntimeTimings {
  return {
    detectMs,
    modelsMs,
    totalMs: detectMs + (modelsMs ?? 0),
  };
}

async function withBudget<T>(
  budgetMs: number,
  work: () => Promise<T>,
): Promise<{ ok: true; value: T; ms: number } | { ok: false; ms: number }> {
  const t0 = nowMs();
  let timer: ReturnType<typeof setTimeout> | undefined = undefined;
  try {
    const value = await Promise.race([
      work().then((v) => ({ tag: "value" as const, v })),
      new Promise<{ tag: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ tag: "timeout" }), budgetMs);
      }),
    ]);
    const ms = nowMs() - t0;
    if (value.tag === "timeout") return { ok: false, ms };
    return { ok: true, value: value.v, ms };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type OneResult =
  | { kind: "absent"; timings: RuntimeTimings }
  | { kind: "present"; desc: RuntimeDescriptor };

async function detectOne(
  d: RuntimeDriver,
  opts: DetectCollectOptions,
): Promise<OneResult> {
  const budget = opts.modelsBudgetMs ?? MODELS_PROBE_BUDGET_MS;
  const tDetect0 = nowMs();
  let det: { readonly version: string } | null = null;
  try {
    det = await d.detect();
  } catch {
    const detectMs = nowMs() - tDetect0;
    return {
      kind: "present",
      desc: {
        runtime: d.id,
        version: "unknown",
        models: [],
        failure: "detect_failed",
        timings: timingsOf(detectMs, null),
      },
    };
  }
  const detectMs = nowMs() - tDetect0;
  if (det === null) {
    return { kind: "absent", timings: timingsOf(detectMs, null) };
  }

  const tModels0 = nowMs();
  try {
    const raced = await withBudget(budget, async () => {
      const models = await d.models();
      const providers =
        typeof d.providers === "function" ? await d.providers() : undefined;
      return { models, providers };
    });

    if (!raced.ok) {
      return {
        kind: "present",
        desc: {
          runtime: d.id,
          version: det.version,
          models: [],
          failure: "models_unavailable",
          timings: timingsOf(detectMs, raced.ms),
        },
      };
    }

    const { models, providers } = raced.value;
    const modelsMs = raced.ms;
    const hasProviderModels = Boolean(
      providers && providers.some((p) => p.models.length > 0),
    );
    if (models.length === 0 && !hasProviderModels) {
      return {
        kind: "present",
        desc: {
          runtime: d.id,
          version: det.version,
          models: [],
          ...(providers !== undefined ? { providers } : {}),
          failure: "models_unavailable",
          timings: timingsOf(detectMs, modelsMs),
        },
      };
    }
    return {
      kind: "present",
      desc: {
        runtime: d.id,
        version: det.version,
        models,
        ...(providers !== undefined ? { providers } : {}),
        timings: timingsOf(detectMs, modelsMs),
      },
    };
  } catch (err) {
    const modelsMs = nowMs() - tModels0;
    if (err instanceof ModelsProbeError) {
      return {
        kind: "present",
        desc: {
          runtime: d.id,
          version: det.version,
          models: [],
          failure: err.failure,
          timings: timingsOf(detectMs, modelsMs),
        },
      };
    }
    return {
      kind: "present",
      desc: {
        runtime: d.id,
        version: det.version,
        models: [],
        failure: "models_unavailable",
        timings: timingsOf(detectMs, modelsMs),
      },
    };
  }
}

/**
 * Detect every runtime on this host.
 * Each driver's detect() is try/caught independently so one throw cannot sink the sweep.
 * null from detect() = genuinely not installed (omit). detect_failed is a distinct state.
 */
export async function detectAll(
  drivers: readonly RuntimeDriver[],
  opts: DetectCollectOptions = {},
): Promise<readonly RuntimeDescriptor[]> {
  const out = await Promise.all(drivers.map((d) => detectOne(d, opts)));
  return out
    .filter((r): r is { kind: "present"; desc: RuntimeDescriptor } => r.kind === "present")
    .map((r) => r.desc);
}

/**
 * Like detectAll, but every `registryId` is represented:
 * - present → normal descriptor
 * - driver detect() null → { failure: "not_installed", models: [] }
 * - no driver for id → { failure: "not_installed", models: [] }
 */
export async function detectAllRegistered(
  drivers: readonly RuntimeDriver[],
  registryIds: readonly string[],
  opts: DetectCollectOptions = {},
): Promise<readonly RuntimeDescriptor[]> {
  const results = await Promise.all(
    drivers.map((d) => detectOne(d, opts).then((r) => ({ id: d.id, r }))),
  );
  const byId = new Map<string, RuntimeDescriptor>();
  for (const { id, r } of results) {
    if (r.kind === "present") {
      byId.set(r.desc.runtime, r.desc);
    } else {
      byId.set(id, {
        runtime: id,
        version: "unknown",
        models: [],
        failure: "not_installed",
        timings: r.timings,
      });
    }
  }

  const out: RuntimeDescriptor[] = [];
  for (const id of registryIds) {
    const existing = byId.get(id);
    if (existing) {
      out.push(existing);
      continue;
    }
    out.push({
      runtime: id,
      version: "unknown",
      models: [],
      failure: "not_installed",
      timings: timingsOf(0, null),
    });
  }
  return out;
}
