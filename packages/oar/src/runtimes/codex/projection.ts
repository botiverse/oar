import type { SessionEventBody, TurnOutcome } from "../../contracts/session.js";
import { classifyFailure } from "../../shared/failure-class.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { codexItemInput, codexItemOutput } from "./item-detail.js";
import { codexReasoningContent } from "./reasoning.js";

/**
 * The codex notification → SessionEvent projection as a PURE FOLD (see
 * runtimes/claude/projection.ts for the shape). Emits kernel commands
 * (begin/emit/settle); the live adapter applies them and separately owns the
 * transport-only codexTurnId (steer/abort identity), which is not part of the
 * projection. Behavior is pinned by tests/replay against recorded fixtures.
 */

const TOOL_ITEM_TYPES = new Set(["commandExecution", "fileChange", "mcpToolCall", "webSearch"]);

export type ProjectionCommand =
  | { readonly kind: "begin" }
  | { readonly kind: "emit"; readonly body: SessionEventBody }
  | { readonly kind: "settle"; readonly outcome: TurnOutcome };

/**
 * `lastErrorDetail` carries codex's structured `error` notification (which its
 * terminal turn status does NOT include) into the failed settle reason.
 */
export interface CodexProjectionState {
  readonly inTurn: boolean;
  readonly lastErrorDetail: string | null;
}

export const initialCodexProjection: CodexProjectionState = { inTurn: false, lastErrorDetail: null };

/** Control plane → state: a prompt (or resume) opens a turn. */
export function codexPrompted(state: CodexProjectionState): CodexProjectionState {
  return { ...state, inTurn: true };
}

// The runtime's own status is the truth: an interrupt that landed reports
// "interrupted"; one that lost the race to completion reports "completed".
function outcomeFromStatus(status: unknown): TurnOutcome {
  switch (status) {
    case "interrupted":
      return { kind: "aborted" };
    case "completed":
      return { kind: "completed" };
    default: {
      const reason = typeof status === "string" ? status : "unknown";
      return { kind: "failed", reason, failure: classifyFailure(reason) };
    }
  }
}

function toolEvents(method: string, item: JsonRecord | null): SessionEventBody[] {
  const itemType = typeof item?.type === "string" ? item.type : "";
  if (!TOOL_ITEM_TYPES.has(itemType)) {
    return [];
  }
  const itemId = typeof item?.id === "string" ? item.id : "unknown";
  if (method === "item/started") {
    const input = item === null ? undefined : codexItemInput(item);
    return [input === undefined
      ? { kind: "tool_call_started", callId: itemId, tool: itemType }
      : { kind: "tool_call_started", callId: itemId, tool: itemType, input }];
  }
  const output = item === null ? undefined : codexItemOutput(item);
  return [output === undefined
    ? { kind: "tool_call_ended", callId: itemId }
    : { kind: "tool_call_ended", callId: itemId, output }];
}

function settleOutcome(state: CodexProjectionState, status: unknown): TurnOutcome {
  const outcome = outcomeFromStatus(status);
  if (outcome.kind === "failed" && state.lastErrorDetail !== null) {
    const reason = `${outcome.reason}: ${state.lastErrorDetail}`;
    return { kind: "failed", reason, failure: classifyFailure(reason) };
  }
  return outcome;
}

function emits(bodies: SessionEventBody[]): ProjectionCommand[] {
  return bodies.map((body) => ({ kind: "emit", body }));
}

/** Fold one codex notification into the next state plus commands. */
export function foldCodexNotification(
  state: CodexProjectionState,
  method: string,
  params: JsonRecord,
): { readonly state: CodexProjectionState; readonly commands: readonly ProjectionCommand[] } {
  if (method === "turn/started") {
    return state.inTurn
      ? { state, commands: [] }
      : { state: { ...state, inTurn: true }, commands: [{ kind: "begin" }] };
  }
  if (method === "error") {
    const error = asRecord(params.error);
    const message = typeof error?.message === "string" ? error.message : "";
    const details = typeof error?.additionalDetails === "string" ? error.additionalDetails : "";
    const combined = [message, details].filter((part) => part.length > 0).join(" — ");
    return combined.length > 0 ? { state: { ...state, lastErrorDetail: combined }, commands: [] } : { state, commands: [] };
  }
  if (!state.inTurn) {
    return { state, commands: [] };
  }
  switch (method) {
    case "item/agentMessage/delta":
      return typeof params.delta === "string"
        ? { state, commands: emits([{ kind: "text_delta", text: params.delta }]) }
        : { state, commands: [] };
    case "rawResponseItem/completed": {
      const content = codexReasoningContent(asRecord(params.item));
      return content === null ? { state, commands: [] } : { state, commands: emits([{ kind: "reasoning", content }]) };
    }
    case "item/started":
    case "item/completed":
      return { state, commands: emits(toolEvents(method, asRecord(params.item))) };
    case "turn/completed":
      return {
        state: { inTurn: false, lastErrorDetail: null },
        commands: [{ kind: "settle", outcome: settleOutcome(state, asRecord(params.turn)?.status) }],
      };
    default:
      return { state, commands: [] };
  }
}
