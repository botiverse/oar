import type { PlanChannel, PlanSnapshot } from "../../contracts/plan.js";
import { todoWriteChecklist } from "../../shared/todo-write-plan.js";

/**
 * claude's own checklist tool ([src] claude 2.1.332 `TodoWrite`, whose
 * description reads "Update the todo list for the current session"): its
 * `todos` argument is the COMPLETE list. It is the runtime's own tool, so the
 * plan event says `evidence: "tool_call"` (the model's claim, not
 * runtime-tracked state) and `channel: "native"`.
 *
 * claude sends no plan notification, so this call is its only native
 * checklist channel (docs/spec/plans.md).
 */
export { TODO_WRITE_TOOL as CLAUDE_CHECKLIST_TOOL } from "../../shared/todo-write-plan.js";

/** The checklist one claude tool call carries, and that its channel is claude's own; null when the call is not a readable checklist. */
export function claudeChecklistTool(tool: string, input: unknown): { readonly plan: PlanSnapshot; readonly channel: PlanChannel } | null {
  const plan = todoWriteChecklist(tool, input);
  return plan === null ? null : { plan, channel: "native" };
}
