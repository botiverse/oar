import type { PlanChannel, PlanSnapshot } from "../../contracts/plan.js";
import type { RuntimeEventBody } from "../../contracts/session.js";
import type { JsonRecord } from "../json.js";
import { contentBlocks } from "./content.js";

/**
 * A dialect's own checklist tool: the tool's name, and what its complete input
 * says, with where that channel comes from (`channel`) so an extension-provided
 * tool is never reported as the runtime's own.
 */
export type StreamJsonChecklistTool = (tool: string, input: unknown) => { readonly plan: PlanSnapshot; readonly channel: PlanChannel } | null;

/**
 * The checklist a stream-json assistant message carries in its own tool call
 * (a model claim, hence `evidence: "tool_call"` and the call id). Read from
 * the completed message's blocks, once per call: the streamed input fragments
 * are never accumulated, so a half-sent checklist is never reported as a whole
 * one. A dialect without a checklist tool returns nothing here.
 */
export function streamJsonChecklistEvents(checklist: StreamJsonChecklistTool | undefined, message: JsonRecord): RuntimeEventBody[] {
  if (checklist === undefined) {
    return [];
  }
  const events: RuntimeEventBody[] = [];
  for (const block of contentBlocks(message)) {
    if (block.type !== "tool_use" || typeof block.name !== "string" || typeof block.id !== "string") {
      continue;
    }
    const read = checklist(block.name, block.input);
    if (read !== null) {
      events.push({ kind: "plan_changed", plan: read.plan, evidence: "tool_call", callId: block.id, channel: read.channel });
    }
  }
  return events;
}
