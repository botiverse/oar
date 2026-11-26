import type { PlanSnapshot, PlanStep } from "../contracts/plan.js";
import { asRecord } from "./json.js";

/**
 * The checklist an EXTENSION tool reports, as a structured result.
 *
 * A runtime that tracks no checklist of its own can still have one: an
 * extension may register a tool whose result carries the whole list. OAR reads
 * that result rather than the call's arguments, because only the result says
 * the tool actually ran and succeeded, and it reports the event only for a tool
 * whose loaded identity the runtime confirmed in that same session
 * ([plans](../docs/spec/plans.md)).
 *
 * The contract is one key under the tool result's `details`, versioned so a
 * later shape is never read as this one:
 *
 * ```jsonc
 * { "details": { "oarPlan": {
 *   "protocol": 1,
 *   "steps": [{ "step": "Read the wire shape", "status": "in_progress" }],
 *   "explanation": "optional, the tool's own words"
 * } } }
 * ```
 *
 * `steps` is the WHOLE list (a replacement, like every other checklist
 * channel) and `steps: []` is the tool's own clear. A result without this key,
 * or with a protocol this OAR does not read, reports no checklist at all.
 */
export const EXTENSION_PLAN_DETAILS_KEY = "oarPlan";

/** The only protocol version this OAR reads. A newer one is not guessed at. */
export const EXTENSION_PLAN_PROTOCOL = 1;

/** What a versioned extension result carries: the checklist and the protocol it was written in. */
export interface ExtensionPlanResult {
  readonly plan: PlanSnapshot;
  /** The `protocol` the result declared; always the one version OAR reads. */
  readonly protocol: number;
}

/** One step as the extension worded it; a status OAR does not know stays visible unchanged. */
function step(value: unknown): PlanStep | null {
  const entry = asRecord(value);
  if (typeof entry?.step !== "string" || typeof entry.status !== "string") {
    return null;
  }
  return { step: entry.step, status: entry.status, ...(typeof entry.priority === "string" ? { priority: entry.priority } : {}) };
}

/**
 * The checklist a tool result's `details` reports, or null when it reports
 * none: a different result shape, a protocol OAR does not read, or a step it
 * cannot read (a half-read list would hide what the extension said).
 */
export function extensionPlanOf(details: unknown): ExtensionPlanResult | null {
  const report = asRecord(asRecord(details)?.[EXTENSION_PLAN_DETAILS_KEY]);
  if (report === null || report.protocol !== EXTENSION_PLAN_PROTOCOL || !Array.isArray(report.steps)) {
    return null;
  }
  const reported: unknown[] = report.steps;
  const steps: PlanStep[] = [];
  for (const value of reported) {
    const parsed = step(value);
    if (parsed === null) {
      return null;
    }
    steps.push(parsed);
  }
  const explanation = typeof report.explanation === "string" && report.explanation.length > 0 ? report.explanation : undefined;
  return { plan: { steps, ...(explanation === undefined ? {} : { explanation }) }, protocol: report.protocol };
}
