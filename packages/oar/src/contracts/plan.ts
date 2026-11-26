/**
 * A checklist the runtime reports: its own plan channel (codex
 * `turn/plan/updated`, an ACP `plan` session update) or the model's complete
 * checklist tool call (claude's built-in `TodoWrite`, DSH's `todo_write`, a Pi
 * `TodoWrite` an installed extension registered). Observation only: OAR never
 * asks the model for a plan, never edits one, never runs its own plan loop, and
 * never derives a checklist from prose, a task or a turn end.
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

/**
 * Where the checklist CHANNEL comes from, which is a second, independent claim
 * from `evidence`: `native` is the runtime's own plan channel or its own tool;
 * `extension` is a tool an extension registered inside the runtime.
 *
 * OAR reports `extension` only for a call the runtime actually made, so the
 * observation is always verified. The extension's IDENTITY is a separate claim
 * and is filled only from what the runtime itself reported about the tool
 * (`extension` below): never from a file OAR found on disk, and never from a
 * runtime version alone. A host that must trust the plugin reads the runtime's
 * inventory, where the same report names the tool's source.
 */
export type PlanChannel = "native" | "extension";

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
  readonly channel: PlanChannel;
  /**
   * The extension a `channel: "extension"` checklist came from, as the RUNTIME
   * reported the tool: the tool's name and the source the runtime named for it.
   * Absent when the runtime reported no such identity, which is not the same as
   * "no extension": OAR never guesses one.
   */
  readonly extension?: { readonly tool: string; readonly source: string };
}
