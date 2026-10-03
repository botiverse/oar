import type { Event, RawEvent } from "../contracts/session.js";
import {
  beginTurn,
  laneFor,
  markRequestAnswered,
  noticePart,
  removeEmptyTurn,
  sealTurn,
  turnForWrite,
  updateToolPart,
  type Draft,
} from "./session-view-fold.js";
import type { PendingRequest } from "./session-view.js";

/**
 * The event-level fold of the session view: one `Event` (or one record's
 * record-level facts in `recordFacts`) applied to the draft. Part kinds and
 * their meaning live in `session-view.ts`; grouping rules in the doc header
 * there (docs/design/chat-ui.md).
 */

export function foldEvent(draft: Draft, event: Event, streamId: string): void {
  // Native echoes are ConversationInput observations, never a second bubble.
  if (event.kind === "user_message") {
    return;
  }
  const scope = draft.rootSessionId ?? event.sessionId;
  switch (event.kind) {
    case "turn_started":
      beginTurn(draft, `turn:${streamId}:${event.requestId}`, event.requestId);
      return;
    case "text_delta": {
      const section = laneFor(draft, event, streamId);
      const last = section?.parts.at(-1);
      if (last?.kind === "text") {
        section?.parts.splice(-1, 1, { kind: "text", text: last.text + event.text });
      } else {
        section?.parts.push({ kind: "text", text: event.text });
      }
      return;
    }
    case "reasoning": {
      const section = laneFor(draft, event, streamId);
      const last = section?.parts.at(-1);
      if (last?.kind === "reasoning" && last.content.kind === "text" && event.content.kind === "text") {
        section?.parts.splice(-1, 1, {
          kind: "reasoning",
          content: { kind: "text", text: last.content.text + event.content.text },
        });
      } else {
        section?.parts.push({ kind: "reasoning", content: event.content });
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
      });
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
      });
      return;
    }
    case "turn_ended":
      if (event.sessionId === scope) {
        let turn = turnForWrite(draft);
        if (turn === null) {
          // A lone end is a fact too: a segment holding only the outcome.
          beginTurn(draft, `turn:${streamId}:${event.sessionId}:${event.seq}`);
          turn = turnForWrite(draft);
        }
        if (turn !== null) {
          turn.outcome = event.outcome;
        }
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
  }
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
