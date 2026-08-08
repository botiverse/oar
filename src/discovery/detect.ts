/**
 * Host-side detection: which runtimes are installed + models(+options).
 * oar never names "computer" — currency is RuntimeDescriptor[].
 */

import type { RuntimeDriver } from "../backend/trait.js";
import type { ModelInfo, ProviderInfo } from "../config/model.js";

/**
 * Why a runtime is not offering models. CLOSED set — never a raw exception string.
 */
export type DetectFailure =
  | "models_unavailable" // detect() ok, models() empty/failed
  | "detect_failed" // detect() threw — installed-ness UNKNOWN, not "absent"
  | "not_installed"; // known registry runtime, host detect returned absent

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
}

async function detectOne(d: RuntimeDriver): Promise<RuntimeDescriptor | null> {
  let det: { readonly version: string } | null = null;
  try {
    det = await d.detect();
  } catch {
    return {
      runtime: d.id,
      version: "unknown",
      models: [],
      failure: "detect_failed",
    };
  }
  if (det === null) {
    return null;
  }
  try {
    const models = await d.models();
    const providers =
      typeof d.providers === "function" ? await d.providers() : undefined;
    return {
      runtime: d.id,
      version: det.version,
      models,
      ...(providers !== undefined ? { providers } : {}),
    };
  } catch {
    return {
      runtime: d.id,
      version: det.version,
      models: [],
      failure: "models_unavailable",
    };
  }
}

/**
 * Detect every runtime on this host.
 * Each driver's detect() is try/caught independently so one throw cannot sink the sweep.
 * null from detect() = genuinely not installed (omit). detect_failed is a distinct state.
 *
 * Tooth 13: every schema fetch path MUST call this (or equivalent fresh detect) —
 * do not serve a process-lifetime cached descriptor list as the form contract.
 */
export async function detectAll(
  drivers: readonly RuntimeDriver[],
): Promise<readonly RuntimeDescriptor[]> {
  const tasks: Promise<RuntimeDescriptor | null>[] = [];
  for (const d of drivers) {
    tasks.push(detectOne(d));
  }
  const out = await Promise.all(tasks);
  return out.filter((desc): desc is RuntimeDescriptor => desc !== null);
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
): Promise<readonly RuntimeDescriptor[]> {
  const found = await detectAll(drivers);
  const foundIds = new Set(found.map((d) => d.runtime));
  const out: RuntimeDescriptor[] = [...found];
  for (const id of registryIds) {
    if (foundIds.has(id)) continue;
    // Driver existed but returned null, or no driver.
    out.push({
      runtime: id,
      version: "unknown",
      models: [],
      failure: "not_installed",
    });
  }
  // Preserve registry order
  const order = new Map(registryIds.map((id, i) => [id, i]));
  out.sort((a, b) => (order.get(a.runtime) ?? 999) - (order.get(b.runtime) ?? 999));
  return out;
}
