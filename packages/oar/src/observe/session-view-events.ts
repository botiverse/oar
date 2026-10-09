import type { Event, RawEvent } from "../contracts/session.js";
import {
  beginTurn,
  laneFor,
  markRequestAnswered,
  noticePart,
  removeEmptyTurn,
  sameLane,
  sealTurn,
  stampTurnOutcome,
  turnForWrite,
  type Draft,
} from "./session-view-fold.js";
import { endRootTools, updateToolInput, updateToolPart } from "./session-view-tools.js";
import type { PendingRequest, ViewPart } from "./session-view.js";

/**
 * The event-level fold of the session view: one `Event` (or one record's
 * record-level facts in `recordFacts`) applied to the draft. Part kinds and
 * their meaning live in `session-view.ts`; grouping rules in the doc header
 * there (docs/design/chat-ui.md).
 */

export function foldEvent(draft: Draft, event: Event, streamId: string): void {
  // Native echoes are ConversationInput observations, never a second bubble.
  if (event.kind === "user_message" || event.kind === "input_dropped") {
    return;
  }
  const scope = draft.rootSessionId ?? event.sessionId;
  switch (event.kind) {
    case "turn_started":
      beginTurn(draft, `turn:${streamId}:${event.requestId}`, event.requestId);
      return;
    case "text_delta": {
      if (appendMessageText(draft, event)) { return; }
      const section = laneFor(draft, event, streamId);
      const last = section?.parts.at(-1);
      // Unnamed text retains stream order (older records, pi, ACP).
      if (last?.kind === "text" && event.messageId === undefined) {
        section?.parts.splice(-1, 1, { ...last, text: last.text + event.text });
      } else {
        section?.parts.push({ kind: "text", text: event.text, ...(event.messageId === undefined ? {} : { messageId: event.messageId }) });
      }
      return;
    }
    case "reasoning": {
      if (appendMessageText(draft, event)) { return; }
      const section = laneFor(draft, event, streamId);
      const last = section?.parts.at(-1);
      if (event.messageId === undefined && last?.kind === "reasoning" && last.content.kind === "text" && event.content.kind === "text") {
        section?.parts.splice(-1, 1, {
          ...last,
          content: { kind: "text", text: last.content.text + event.content.text },
        });
      } else {
        section?.parts.push({ kind: "reasoning", content: event.content, ...(event.messageId === undefined ? {} : { messageId: event.messageId }) });
      }
      return;
    }
    case "tool_call_started":
      laneFor(draft, event, streamId)?.parts.push({
        kind: "tool",
        callId: event.callId,
        tool: event.tool,
        ...(event.input === undefined ? {} : { input: event.input }),
        result: "running",
        startedAt: event.receivedAt,
      });
      return;
    case "tool_call_input":
      if (updateToolInput(draft, event)) {
        return;
      }
      // An input without a start is still a fact (mid-turn subscriber).
      laneFor(draft, event, streamId)?.parts.push({ kind: "tool", callId: event.callId, tool: "?", input: event.input, result: "running" });
      return;
    case "tool_call_progress":
    case "tool_call_ended": {
      const result = event.kind === "tool_call_progress" ? "running" : (event.result ?? "ended");
      if (updateToolPart(draft, event, result)) {
        return;
      }
      // An end without a start is still a fact (mid-turn subscriber).
      laneFor(draft, event, streamId)?.parts.push({
        kind: "tool",
        callId: event.callId,
        tool: "?",
        ...(event.kind === "tool_call_progress" && event.output !== undefined ? { output: event.output } : {}),
        ...(event.kind === "tool_call_ended" && event.content !== undefined ? { content: event.content } : {}),
        result,
        ...(event.kind === "tool_call_ended" ? { endedAt: event.receivedAt } : {}),
      });
      return;
    }
    case "turn_ended":
      if (event.sessionId === scope && event.agentPath.length === 0) {
        endRootTools(draft, scope);
        stampTurnOutcome(draft, `turn:${streamId}:${event.sessionId}:${event.seq}`, event.outcome);
        sealTurn(draft);
      } else {
        noticePart(draft, event, streamId, { cause: "child_turn_ended", outcome: event.outcome });
      }
      return;
    case "compaction_started":
      noticePart(draft, event, streamId, {
        cause: "compaction_started",
        ...(event.trigger === undefined ? {} : { trigger: event.trigger }),
      });
      return;
    case "compaction_ended":
      noticePart(draft, event, streamId, {
        cause: "compaction_ended",
        outcome: event.outcome,
        ...(event.trigger === undefined ? {} : { trigger: event.trigger }),
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      });
      return;
    case "retry":
      noticePart(draft, event, streamId, {
        cause: "retry",
        attempt: event.attempt,
        ...(event.maxAttempts === undefined ? {} : { maxAttempts: event.maxAttempts }),
        ...(event.delayMs === undefined ? {} : { delayMs: event.delayMs }),
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      });
      return;
    case "app_request": {
      if (!draft.pendingRequests.some((request) => request.requestId === event.requestId)) {
        draft.pendingRequests.push({
          requestId: event.requestId,
          type: event.type,
          sessionId: event.sessionId,
          agentPath: event.agentPath,
          seq: event.seq,
        });
      }
      laneFor(draft, event, streamId)?.parts.push({
        kind: "app_request",
        requestId: event.requestId,
        type: event.type,
        answered: false,
      });
      return;
    }
    case "app_answered":
      markRequestAnswered(draft, event.requestId);
      return;
    case "control_rejected":
      if (event.action === "prompt") {
        removeEmptyTurn(draft, event.requestId);
      } else if (draft.openTurn !== -1) {
        noticePart(draft, event, streamId, {
          cause: "control_rejected",
          action: event.action,
          reason: event.reason,
        });
      } else {
        draft.messages.push({
          kind: "notice",
          id: `nt:${streamId}:${event.sessionId}:${event.seq}`,
          notice: { cause: "control_rejected", action: event.action, reason: event.reason },
        });
      }
      return;
    case "exited":
      if (event.sessionId !== scope || event.agentPath.length > 0) {
        noticePart(draft, event, streamId, { cause: "exited", code: event.code });
        return;
      }
      endRootTools(draft, scope);
      draft.exited = { code: event.code };
      draft.messages.push({
        kind: "notice",
        id: `nt:${streamId}:${event.sessionId}:${event.seq}`,
        notice: { cause: "exited", code: event.code },
      });
      sealTurn(draft);
      return;
    case "usage":
      if (event.sessionId === scope) {
        if (event.usage.tokens !== undefined) {
          draft.usageByAgent.set(JSON.stringify(event.agentPath), {
            agentPath: event.agentPath,
            tokens: event.usage.tokens,
          });
        }
        if (event.usage.context !== undefined && event.agentPath.length === 0) {
          draft.context = event.usage.context;
        }
      }
      return;
    case "model":
      if (event.sessionId === scope && event.agentPath.length === 0) {
        draft.model = event.model;
      }
      return;
    case "service_tier":
      if (event.sessionId === scope && event.agentPath.length === 0) { draft.serviceTier = event.serviceTier; }
      break;
    case "effort":
      if (event.sessionId === scope && event.agentPath.length === 0) {
        draft.effort = event.effort;
      }
      break;
    case "task_started":
    case "task_updated":
    case "task_ended":
      // Tasks are not transcript content; `tasksOf` folds them for a task panel.
      break;
    case "input_withdrawn":
      // Input facts reach the view as conversation updates: a withdrawn input
      // leaves the lists there. A withdraw of an input never folded has nothing to remove.
      break;
  }
}

/** Named text rejoins its own part, only inside the current unsealed segment. */
function appendMessageText(draft: Draft, event: Extract<Event, { kind: "text_delta" | "reasoning" }>): boolean {
  if (event.messageId === undefined || (event.kind === "reasoning" && event.content.kind !== "text")) {
    return false;
  }
  const turn = turnForWrite(draft);
  if (turn === null) { return false; }
  for (let s = turn.sections.length - 1; s >= 0; s -= 1) {
    const section = turn.sections[s];
    if (section === undefined || !sameLane(section, event.sessionId, event.agentPath)) { continue; }
    for (let p = section.parts.length - 1; p >= 0; p -= 1) {
      const part = section.parts[p];
      let updated: ViewPart | undefined = undefined;
      if (part?.kind === "text" && event.kind === "text_delta" && part.messageId === event.messageId) {
        updated = { ...part, text: part.text + event.text };
      } else if (part?.kind === "reasoning" && event.kind === "reasoning" && part.messageId === event.messageId && part.content.kind === "text" && event.content.kind === "text") {
        updated = { ...part, content: { kind: "text", text: part.content.text + event.content.text } };
      }
      if (updated === undefined) { continue; }
      const parts = [...section.parts];
      parts[p] = updated;
      turn.sections[s] = { ...section, parts };
      return true;
    }
  }
  return false;
}

// ─── Record-level facts the flat event reading does not carry ─────────────

export function recordFacts(draft: Draft, record: RawEvent, streamId: string): void {
  if (record.kind === "request" && record.direction === "toApp") {
    const entry: PendingRequest = {
      requestId: record.id,
      type: record.body.kind === "native" ? record.body.type : record.body.kind,
      sessionId: record.sessionId,
      agentPath: record.agentPath,
      seq: record.seq,
      body: record.body.kind === "native" ? record.body.native : record.body,
    };
    const existing = draft.pendingRequests.findIndex((request) => request.requestId === record.id);
    if (existing === -1) {
      draft.pendingRequests.push(entry);
    } else {
      draft.pendingRequests[existing] = entry;
    }
    return;
  }
  if (record.kind === "request" && record.direction === "toRuntime" && record.body.kind === "prompt") {
    // After the input update landed: the turn opens below its own bubble.
    beginTurn(draft, `turn:${streamId}:${record.id}`, record.id);
    return;
  }
  if (record.kind === "response" && record.body.kind === "rejected" && draft.openTurn !== -1) {
    removeEmptyTurn(draft, record.requestId);
  }
}
