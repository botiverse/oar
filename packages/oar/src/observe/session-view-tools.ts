import type { Event } from "../contracts/session.js";
import { sameLane, type Draft } from "./session-view-fold.js";
import type { ViewPart, ViewSection } from "./session-view.js";

/**
 * A root turn boundary ends its unresolved calls, without claiming a result
 * or a native tool end time. Inputs may have split the turn into segments;
 * walk back to its prompt, the preceding outcome, or the preceding exit.
 */
export function endRootTools(draft: Draft, sessionId: string): void {
  for (let index = draft.messages.length - 1; index >= 0; index -= 1) {
    const message = draft.messages[index];
    if (message?.kind === "notice" && message.notice.cause === "exited") { break; }
    if (message?.kind !== "turn") { continue; }
    // The record fold may already have stamped this segment's exit outcome.
    if (index !== draft.openTurn && message.outcome !== undefined) { break; }
    const sections = message.sections.map((section) => endRootSectionTools(section, sessionId));
    if (sections.some((section, s) => section !== message.sections[s])) {
      draft.messages[index] = { ...message, sections };
      if (index === draft.openTurn) { draft.turn = null; }
    }
    if (message.openedBy !== undefined) { break; }
  }
}

function endRootSectionTools(section: ViewSection, sessionId: string): ViewSection {
  if (!sameLane(section, sessionId, []) || !section.parts.some((part) => part.kind === "tool" && part.result === "running")) {
    return section;
  }
  return { ...section, parts: section.parts.map((part) => {
    if (part.kind !== "tool" || part.result !== "running") { return part; }
    const { content: _content, ...unfinished } = part;
    return { ...unfinished, result: "ended" };
  }) };
}

type ToolUpdate = Extract<Event, { kind: "tool_call_progress" | "tool_call_ended" }>;
type ToolInput = Extract<Event, { kind: "tool_call_input" }>;
type ToolPart = Extract<ViewPart, { kind: "tool" }>;
type ToolResult = ToolPart["result"];

/** A snapshot replaces the current preview; a delta appends to it. */
export function toolPreview(previous: string | undefined, event: Extract<Event, { kind: "tool_call_progress" }>): { readonly output?: string } {
  const snapshot = event.output ?? previous;
  const output = event.outputDelta === undefined ? snapshot : (snapshot ?? "") + event.outputDelta;
  return output === undefined ? {} : { output };
}

/**
 * Settle a call's tool part in place, in whichever turn its start landed
 * (one part per lane and callId): a runtime may report a call's last output
 * after its turn ended (codex `commandExecution/outputDelta` after
 * `turn/completed`). False when no part holds the callId.
 */
export function updateToolPart(draft: Draft, event: ToolUpdate, result: ToolResult): boolean {
  return replaceToolPart(draft, event, (part) => {
    if (event.kind === "tool_call_ended") {
      // The streamed preview gives way to the result.
      const { output: _streamed, ...settled } = part;
      return { ...settled, ...(event.content === undefined ? {} : { content: event.content }), result, endedAt: event.receivedAt };
    }
    // A late output delta adds evidence; it cannot reopen an ended call.
    return { ...part, ...toolPreview(part.output, event) };
  });
}

/** The latest input the runtime reported replaces the call's earlier one; its state is untouched. False when no part holds the callId. */
export function updateToolInput(draft: Draft, event: ToolInput): boolean {
  return replaceToolPart(draft, event, (part) => ({ ...part, input: event.input }));
}

function replaceToolPart(draft: Draft, event: ToolUpdate | ToolInput, next: (part: ToolPart) => ToolPart): boolean {
  for (let m = draft.messages.length - 1; m >= 0; m -= 1) {
    const message = draft.messages[m];
    if (message?.kind !== "turn") {
      continue;
    }
    for (let s = message.sections.length - 1; s >= 0; s -= 1) {
      const section = message.sections[s];
      const partIndex =
        section === undefined || !sameLane(section, event.sessionId, event.agentPath)
          ? -1
          : section.parts.findIndex((part) => part.kind === "tool" && part.callId === event.callId);
      const part = partIndex === -1 ? undefined : section?.parts[partIndex];
      if (section === undefined || part?.kind !== "tool") {
        continue;
      }
      const parts = [...section.parts];
      parts[partIndex] = next(part);
      const sections = [...message.sections];
      sections[s] = { ...section, parts };
      draft.messages[m] = { ...message, sections };
      if (m === draft.openTurn) {
        draft.turn = null;
      }
      return true;
    }
  }
  return false;
}
