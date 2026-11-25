import type { PlanSnapshot, PlanStep, PlanStepStatus } from "../../contracts/plan.js";
import type { RuntimeEventBody } from "../../contracts/session.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";

/**
 * Codex's app-server spells the in-flight step `inProgress` while its own
 * `update_plan` tool takes `in_progress`; the contract keeps the latter and
 * leaves any status word OAR does not know exactly as codex sent it.
 */
function stepStatus(status: string): PlanStepStatus {
  return status === "inProgress" ? "in_progress" : status;
}

/** One `plan` member, or undefined for a member OAR cannot read (the whole observation then stays native-only). */
function step(value: unknown): PlanStep | undefined {
  const entry = asRecord(value);
  if (typeof entry?.step !== "string" || typeof entry.status !== "string") {
    return undefined;
  }
  return { step: entry.step, status: stepStatus(entry.status) };
}

/**
 * `turn/plan/updated` carries the turn's whole checklist and replaces any
 * earlier one, so `plan: []` is codex's own clear, not missing evidence.
 * `explanation` is codex's own account of the plan, kept only when non-empty.
 */
export function codexPlanSnapshot(params: JsonRecord): PlanSnapshot | undefined {
  if (!Array.isArray(params.plan)) {
    return undefined;
  }
  const reported: unknown[] = params.plan;
  const steps: PlanStep[] = [];
  for (const value of reported) {
    const parsed = step(value);
    if (parsed === undefined) {
      return undefined;
    }
    steps.push(parsed);
  }
  return {
    steps,
    ...(typeof params.explanation === "string" && params.explanation.length > 0 ? { explanation: params.explanation } : {}),
  };
}

/** The checklist event a `turn/plan/updated` notification reads as; nothing else produces one. */
export function codexPlanEvents(method: string, params: JsonRecord): RuntimeEventBody[] {
  if (method !== "turn/plan/updated") {
    return [];
  }
  const plan = codexPlanSnapshot(params);
  return plan === undefined ? [] : [{ kind: "plan_changed", plan, evidence: "plan_update" }];
}
