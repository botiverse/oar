/**
 * Host-side detection: which runtimes are installed + models(+support).
 * oar never names "computer" — currency is RuntimeDescriptor[].
 */

import type { RuntimeDriver } from "../backend/trait.js";
import type { ModelInfo } from "../config/model.js";

/**
 * Why a runtime is not offering models. CLOSED set — never a raw exception string
 * (scrub: values do not leave; only closed-set names do).
 */
export type DetectFailure =
  | "models_unavailable" // detect() ok, models() failed
  | "detect_failed"; // detect() threw — installed-ness UNKNOWN, not "absent"

export interface RuntimeDescriptor {
  readonly runtime: string;
  readonly version: string;
  readonly models: readonly ModelInfo[];
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
    return {
      runtime: d.id,
      version: det.version,
      models: await d.models(),
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
