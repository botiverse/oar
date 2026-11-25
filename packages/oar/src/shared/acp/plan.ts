import type { PlanStep } from "../../contracts/plan.js";
import type { RuntimeEventBody } from "../../contracts/session.js";
import { asRecord, type JsonRecord } from "../json.js";

/** One ACP `PlanEntry` (`{content, priority, status}`), or undefined when oar cannot read it. */
function step(value: unknown): PlanStep | undefined {
  const entry = asRecord(value);
  if (typeof entry?.content !== "string" || typeof entry.status !== "string") {
    return undefined;
  }
  return { step: entry.content, status: entry.status, ...(typeof entry.priority === "string" ? { priority: entry.priority } : {}) };
}

/**
 * The ACP `plan` session update: the agent's WHOLE checklist, which replaces
 * the previous one ([schema] `Plan.entries`), so `entries: []` is the agent's
 * own clear. ACP defines no explanation and no step identity ([schema] ACP
 * 1.4.0 `PlanUpdate`/`PlanEntry`).
 */
export function acpPlanEvents(update: JsonRecord): RuntimeEventBody[] {
  if (!Array.isArray(update.entries)) {
    return [];
  }
  const entries: unknown[] = update.entries;
  const steps: PlanStep[] = [];
  for (const value of entries) {
    const parsed = step(value);
    if (parsed === undefined) {
      return [];
    }
    steps.push(parsed);
  }
  return [{ kind: "plan_changed", plan: { steps }, evidence: "plan_update" }];
}
