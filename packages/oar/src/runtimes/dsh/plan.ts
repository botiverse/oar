import type { PlanStep } from "../../contracts/plan.js";
import type { RuntimeEventBody } from "../../contracts/session.js";
import { asRecord, parseJson, type JsonRecord } from "../../shared/json.js";

/**
 * DSH's checklist tool (dsh-name-tools [env] 0.2.2-rc.1 and the 0.2.1-rc.5
 * request header): its `todos` argument is the COMPLETE list, replacing any
 * previous one, and each item is `{content, status}`.
 */
const TODO_TOOL = "todo_write";

/** The tool call itself, as dsh reports it on `tool/call`. */
function startedEvents(data: JsonRecord): RuntimeEventBody[] {
  return typeof data.callId === "string" && typeof data.name === "string"
    ? [{ kind: "tool_call_started", callId: data.callId, tool: data.name, ...(typeof data.arguments === "string" ? { input: data.arguments } : {}) }]
    : [];
}

/**
 * DSH reports no plan channel of its own, so the only native checklist is the
 * model's `todo_write` call: the model's own claim, which is why the event
 * says `evidence: "tool_call"` and names the call. Arguments that do not
 * parse, a call without `todos`, or an unreadable item produce no plan event
 * and the call's frame stays as the record.
 */
function planEvents(data: JsonRecord): RuntimeEventBody[] {
  if (data.name !== TODO_TOOL || typeof data.arguments !== "string") {
    return [];
  }
  const todos = asRecord(parseJson(data.arguments))?.todos;
  if (!Array.isArray(todos)) {
    return [];
  }
  const reported: unknown[] = todos;
  const steps: PlanStep[] = [];
  for (const value of reported) {
    const todo = asRecord(value);
    if (typeof todo?.content !== "string" || typeof todo.status !== "string") {
      return [];
    }
    steps.push({ step: todo.content, status: todo.status });
  }
  return [{
    kind: "plan_changed",
    plan: { steps },
    evidence: "tool_call",
    channel: "native",
    ...(typeof data.callId === "string" ? { callId: data.callId } : {}),
  }];
}

/** What oar reads out of one native `tool/call`: the call, and the checklist when the call is the checklist tool. */
export function dshToolCallEvents(data: JsonRecord): RuntimeEventBody[] {
  return [...startedEvents(data), ...planEvents(data)];
}
