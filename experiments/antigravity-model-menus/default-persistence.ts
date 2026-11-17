/** Observe saved defaults through fresh native processes, never by rewriting native files. */
import { isDeepStrictEqual } from "node:util";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { probeRealMenus, type ProbeOptions, type Selection } from "./probe.js";

export function probeFailed(report: JsonRecord): boolean {
  return report.failure !== null || report.closeFailed === true || asRecord(report.restoration)?.confirmed === false;
}

function initialSelection(report: JsonRecord): Selection | null {
  const initial = asRecord(report.initial), thoughtLevel = asRecord(initial?.thoughtLevel);
  if (probeFailed(report) || typeof initial?.model !== "string" ||
    (thoughtLevel !== null && typeof thoughtLevel.currentValue !== "string")) { return null; }
  return { model: initial.model, effort: typeof thoughtLevel?.currentValue === "string" ? thoughtLevel.currentValue : null };
}

async function safeProbe(options: ProbeOptions): Promise<JsonRecord> {
  try { return await probeRealMenus(options); }
  catch { return { failure: { phase: "setup_or_cleanup" }, restoration: null }; }
}

export async function probeDefaultPersistence(options: Omit<ProbeOptions, "mode">, baseline: JsonRecord): Promise<JsonRecord> {
  const original = initialSelection(baseline);
  const models: unknown[] = Array.isArray(baseline.modelIds) ? baseline.modelIds : [];
  const target = models.findLast(model => typeof model === "string" && model !== original?.model);
  if (original === null || typeof target !== "string") { return { status: "inconclusive", reason: "no_known_alternative_selection" }; }
  const report: JsonRecord = { status: "inconclusive", original, targetModel: target, restoration: null };
  let needsRestoration = true;
  try {
    const left = await safeProbe({ ...options, mode: "leave_selected", targetModel: target, expectedInitial: original });
    report.leaveSelected = left;
    const fresh = await safeProbe({ ...options, mode: "baseline" });
    report.freshAfterSelection = fresh;
    const observed = initialSelection(fresh);
    needsRestoration = observed === null || !isDeepStrictEqual(original, observed);
    report.observed = observed;
    if (!probeFailed(left) && observed !== null) {
      if (isDeepStrictEqual(original, observed)) { report.status = "default_unchanged"; }
      else { report.status = observed.model === target ? "selected_model_persisted" : "other_default_change"; }
    }
  } finally {
    // Unknown readback also triggers best-effort restoration after the deliberate mutation.
    if (needsRestoration) {
      const restored = await safeProbe({ ...options, mode: "restore", restoreSelection: original });
      const fresh = await safeProbe({ ...options, mode: "baseline" });
      report.restoration = { run: restored, freshAfterRestore: fresh,
        confirmed: !probeFailed(restored) && isDeepStrictEqual(initialSelection(fresh), original) };
    }
  }
  return report;
}
