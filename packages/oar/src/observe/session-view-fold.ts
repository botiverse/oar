import type {
  ContextUsage,
  Event,
  SessionUsage,
  TokenTotals,
  TurnOutcome,
} from "../contracts/session.js";
import type { AgentStatus } from "./agent-status.js";
import type { ConversationInput, ConversationState } from "./conversation.js";
import type {
  AgentTokens,
  PendingRequest,
  SessionView,
  ViewMessage,
  ViewNotice,
  ViewPart,
  ViewSection,
} from "./session-view.js";

/**
 * Per-record fold internals for `session-view.ts`. Every reduction works on
 * a `Draft`: the message array copied once per record, the open turn and its
 * sections cloned lazily on first write, everything else shared until
 * touched. Nothing here is exported from the package; the public folds call
 * `draftOf` → `foldEvent`/`upsertInput`/`recordFacts` → `assemble`.
 */

export interface Draft {
  messages: ViewMessage[];
  openTurn: number;
  /** The clone of `messages[openTurn]` once written this record; null before. */
  turn: MutableTurn | null;
  pendingRequests: PendingRequest[];
  model: string | null;
  effort: string | null;
  context: ContextUsage | null;
  exited: { readonly code: number | null } | null;
  usageByAgent: Map<string, AgentTokens>;
  rootSessionId: string | undefined;
}

export function draftOf(state: SessionView): Draft {
  return {
    messages: [...state.messages],
    openTurn: state.openTurn,
    turn: null,
    pendingRequests: [...state.pendingRequests],
    model: state.model,
    effort: state.effort,
    context: state.context,
    exited: state.exited,
    usageByAgent: new Map(state.usageByAgent),
    rootSessionId: state.rootSessionId,
  };
}

export function assemble(
  draft: Draft,
  conversation: ConversationState,
  status: AgentStatus,
): SessionView {
  const byAgent = [...draft.usageByAgent.values()];
  const total =
    byAgent.length === 0
      ? null
      : byAgent.reduce<TokenTotals>(
          (sum, entry) => ({
            input: sum.input + entry.tokens.input,
            output: sum.output + entry.tokens.output,
          }),
          { input: 0, output: 0 },
        );
  const onlyRoot = byAgent.every((entry) => entry.agentPath.length === 0);
  const usage: SessionUsage =
    total === null ? { total: null } : (byAgent.length <= 1 && onlyRoot ? { total } : { total, byAgent });
  return {
    messages: draft.messages,
    openTurn: draft.openTurn,
    status,
    model: draft.model,
    effort: draft.effort,
    context: draft.context,
    usage,
    pendingRequests: draft.pendingRequests,
    exited: draft.exited,
    conversation,
    rootSessionId: draft.rootSessionId,
    usageByAgent: draft.usageByAgent,
  };
}

// ─── Turn and section access ──────────────────────────────────────────────

/** The open turn's writable face inside the draft. */
interface MutableTurn {
  readonly kind: "turn";
  readonly id: string;
  readonly openedBy?: string;
  sections: ViewSection[];
  outcome?: TurnOutcome;
}

interface MutableSection {
  readonly sessionId: string;
  readonly agentPath: readonly string[];
  parts: ViewPart[];
}

export function sameLane(section: ViewSection, sessionId: string, agentPath: readonly string[]): boolean {
  return (
    section.sessionId === sessionId &&
    section.agentPath.length === agentPath.length &&
    section.agentPath.every((segment, index) => segment === agentPath[index])
  );
}

/** The open turn, cloned for writing at most once per record. */
export function turnForWrite(draft: Draft): MutableTurn | null {
  if (draft.openTurn === -1) {
    return null;
  }
  if (draft.turn === null) {
    const current = draft.messages[draft.openTurn];
    if (current?.kind !== "turn") {
      return null;
    }
    const clone: MutableTurn = { ...current, sections: [...current.sections] };
    draft.messages[draft.openTurn] = clone;
    draft.turn = clone;
  }
  return draft.turn;
}

export function beginTurn(draft: Draft, id: string, openedBy?: string): void {
  const turn: MutableTurn = {
    kind: "turn",
    id,
    ...(openedBy === undefined ? {} : { openedBy }),
    sections: [],
  };
  draft.messages.push(turn);
  draft.openTurn = draft.messages.length - 1;
  draft.turn = turn;
}

/** Seal the current segment without an outcome; later content opens a new one. */
export function sealTurn(draft: Draft): void {
  draft.openTurn = -1;
  draft.turn = null;
}

/** The last section of the open turn when it matches the lane, else a new one. */
function sectionFor(draft: Draft, sessionId: string, agentPath: readonly string[]): MutableSection | null {
  const turn = turnForWrite(draft);
  if (turn === null) {
    return null;
  }
  const last = turn.sections.at(-1);
  if (last !== undefined && sameLane(last, sessionId, agentPath)) {
    const cloned: MutableSection = { ...last, parts: [...last.parts] };
    turn.sections[turn.sections.length - 1] = cloned;
    return cloned;
  }
  const created: MutableSection = { sessionId, agentPath, parts: [] };
  turn.sections.push(created);
  return created;
}

/** Open a segment when none is running, then give the event's lane. */
export function laneFor(draft: Draft, event: Event, streamId: string): MutableSection | null {
  if (draft.openTurn === -1) {
    beginTurn(draft, `turn:${streamId}:${event.sessionId}:${event.seq}`);
  }
  return sectionFor(draft, event.sessionId, event.agentPath);
}

export function noticePart(draft: Draft, event: Event, streamId: string, notice: ViewNotice): void {
  laneFor(draft, event, streamId)?.parts.push({ kind: "notice", notice });
}

/** Upsert a user input; a NEW input seals the open segment (seq order is render order). */
export function upsertInput(draft: Draft, input: ConversationInput): void {
  const id = `in:${input.id}`;
  const index = draft.messages.findIndex((message) => message.id === id);
  const message: ViewMessage = { kind: "input", id, input };
  if (index === -1) {
    draft.messages.push(message);
    sealTurn(draft);
  } else {
    draft.messages[index] = message;
  }
}

export function markRequestAnswered(draft: Draft, requestId: string): void {
  const index = draft.pendingRequests.findIndex((request) => request.requestId === requestId);
  if (index !== -1) {
    draft.pendingRequests.splice(index, 1);
  }
  for (let m = draft.messages.length - 1; m >= 0; m -= 1) {
    const message = draft.messages[m];
    if (message?.kind !== "turn") {
      continue;
    }
    for (let s = 0; s < message.sections.length; s += 1) {
      const section = message.sections[s];
      const partIndex =
        section?.parts.findIndex(
          (part) => part.kind === "app_request" && part.requestId === requestId,
        ) ?? -1;
      const part = partIndex === -1 ? undefined : section?.parts[partIndex];
      if (section === undefined || part?.kind !== "app_request") {
        continue;
      }
      const parts = [...section.parts];
      parts[partIndex] = { ...part, answered: true };
      const sections = [...message.sections];
      sections[s] = { ...section, parts };
      draft.messages[m] = { ...message, sections };
      if (m === draft.openTurn) {
        draft.turn = null;
      }
      return;
    }
  }
}

type ToolUpdate = Extract<Event, { kind: "tool_call_progress" | "tool_call_ended" }>;
type ToolResult = Extract<ViewPart, { kind: "tool" }>["result"];

/**
 * Settle a call's tool part in place, in whichever turn its start landed
 * (one part per lane and callId): a runtime may report a call's last output
 * after its turn ended (codex `commandExecution/outputDelta` after
 * `turn/completed`). False when no part holds the callId.
 */
export function updateToolPart(draft: Draft, event: ToolUpdate, result: ToolResult): boolean {
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
      if (event.kind === "tool_call_ended") {
        // The streamed preview gives way to the result.
        const { output: _streamed, ...settled } = part;
        parts[partIndex] = { ...settled, ...(event.content === undefined ? {} : { content: event.content }), result };
      } else {
        parts[partIndex] = { ...part, ...(event.output === undefined ? {} : { output: event.output }), result };
      }
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

/** Drop a turn the runtime says never began (rejected prompt), when still empty. */
export function removeEmptyTurn(draft: Draft, requestId: string): void {
  if (draft.openTurn === -1) {
    return;
  }
  const message = draft.messages[draft.openTurn];
  if (message?.kind === "turn" && message.openedBy === requestId && message.sections.length === 0) {
    draft.messages.splice(draft.openTurn, 1);
    draft.openTurn = -1;
  }
}
