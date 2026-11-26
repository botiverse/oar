import type { PlanSnapshot, PlanStep } from "../contracts/plan.js";
import { asRecord } from "./json.js";

/**
 * claude's own built-in checklist tool ([src] claude 2.1.332, "Update the todo
 * list for the current session"). Its `todos` argument is the COMPLETE list,
 * replacing any previous one, and each item is `{content, status, activeForm?}`
 * with `status` one of `pending`, `in_progress` or `completed`.
 *
 * This reads a tool the RUNTIME itself provides. It is not a generic rule: an
 * extension tool of the same name is a different, unverified claim, so a
 * runtime that is not known to ship this tool must not be read through it
 * ([plans](../../../docs/spec/plans.md)).
 */
export const TODO_WRITE_TOOL = "TodoWrite";

/**
 * The checklist one tool call carries, or null when this call is not a
 * readable checklist: a different tool, no `todos` array (an argument list a
 * malformed call sent), or an item without its step text and status. A null
 * never becomes an invented empty checklist; the call's own frame stays the
 * record.
 */
export function todoWriteChecklist(tool: string, input: unknown): PlanSnapshot | null {
  if (tool !== TODO_WRITE_TOOL) {
    return null;
  }
  const todos = asRecord(input)?.todos;
  if (!Array.isArray(todos)) {
    return null;
  }
  const reported: unknown[] = todos;
  const steps: PlanStep[] = [];
  for (const value of reported) {
    const todo = asRecord(value);
    if (typeof todo?.content !== "string" || typeof todo.status !== "string") {
      return null;
    }
    steps.push({ step: todo.content, status: todo.status });
  }
  return { steps };
}
