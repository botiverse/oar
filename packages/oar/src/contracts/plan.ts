/**
 * A checklist the runtime itself reports: its own plan channel (codex
 * `turn/plan/updated`, an ACP `plan` session update) or the model's complete
 * checklist tool call (DSH `todo_write`). Observation only: OAR never asks the
 * model for a plan, never edits one, never runs its own plan loop, and never
 * derives a checklist from prose, a task or a turn end.
 */
export type KnownPlanStepStatus = "pending" | "in_progress" | "completed";
/** Known statuses autocomplete; a native status word OAR does not know stays visible unchanged. */
export type PlanStepStatus = KnownPlanStepStatus | (string & Record<never, never>);

/**
 * Where an observed checklist came from, because the two are not the same
 * claim: `plan_update` is checklist state the runtime tracks and re-sends
 * whole; `tool_call` is the model's own checklist tool call, read from the
 * complete arguments it chose to send.
 */
export type PlanEvidence = "plan_update" | "tool_call";

/** One step as the runtime worded it. */
export interface PlanStep {
  /** The step text: codex `step`, ACP and DSH `content`. Never trimmed, summarized or re-worded. */
  readonly step: string;
  readonly status: PlanStepStatus;
  /** The runtime's own priority word (ACP `high` | `medium` | `low`), only when it reported one. */
  readonly priority?: string;
}

/**
 * One observation of the WHOLE checklist, because every native channel
 * replaces the previous list instead of patching it: there is no delta and no
 * step identity to merge. `steps: []` is the runtime's own empty list, a clear;
 * a runtime with no checklist channel reports nothing at all, which is a
 * different fact and never becomes an empty snapshot.
 */
export interface PlanSnapshot {
  readonly steps: readonly PlanStep[];
  /** The runtime's own account of the plan, when it gave a non-empty one (codex `explanation`). */
  readonly explanation?: string;
}

/**
 * The event one native checklist observation becomes. `evidence` says which
 * native channel it came from, and `callId` names the call when the checklist
 * was a tool call, so a host can pair it with that call's records without
 * reading `native`. Not a task, not a transcript message, never derived from
 * a turn end.
 */
export interface PlanEventBody {
  readonly kind: "plan_changed";
  readonly plan: PlanSnapshot;
  readonly evidence: PlanEvidence;
  readonly callId?: string;
}
