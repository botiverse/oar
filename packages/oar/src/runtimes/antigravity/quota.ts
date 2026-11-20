import type { RawEvent, TurnOutcome } from "../../contracts/session.js";
import { acpErrorReason, rpcErrorCode } from "../../shared/acp/failure.js";
import { utcInstantFromDate } from "../../shared/instant.js";
import type { JsonRecord } from "../../shared/json.js";

// [rec] agy 1.5.12/1.5.13 Gemini individual-quota notice and countdown
// (experiments/antigravity-prompt-usage/README.md). Prompt errors may wrap it.
const QUOTA = /Individual quota reached\. Please upgrade your subscription to increase your limits\. Resets in (?=\d)(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?\./u;
const METADATA_FRAMES = new Set([
  "session_info_update",
  "config_option_update",
  "available_commands_update",
  "current_mode_update",
]);

function quotaOutcome(reason: string, receivedAt: number, standalone: boolean): TurnOutcome | null {
  const match = QUOTA.exec(reason);
  if (match === null) { return null; }
  if (standalone && reason !== `\n⚠ ${match[0]}\n`) { return null; }
  const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  const resetsAt = utcInstantFromDate(new Date(receivedAt + seconds * 1000));
  return resetsAt === null ? null : { kind: "failed", failure: "quota", reason, resetsAt };
}

export function antigravityQuotaError(error: unknown, receivedAt = Date.now()): TurnOutcome | null {
  return rpcErrorCode(error) === null ? null : quotaOutcome(acpErrorReason(error), receivedAt, false);
}

/**
 * Matches agy's standalone quota notice at turn start or as the final step
 * after earlier tool work. A real model reply emits `usage_update` after its
 * text (and reports `usage` on `session/prompt` when no earlier step ran);
 * agy's synthetic quota step emits neither after the notice.
 */
export function antigravityQuotaNotice(response: JsonRecord, turnRecords: () => readonly RawEvent[]): TurnOutcome | null {
  if (response.stopReason !== "end_turn") { return null; }
  const state = { priorTool: false, text: "", receivedAt: 0, blocked: false };
  const reset = (tool: boolean): void => {
    state.priorTool = tool;
    state.text = "";
    state.receivedAt = 0;
    state.blocked = false;
  };
  for (const record of turnRecords()) {
    if (record.kind === "request" && record.direction === "toApp") { state.blocked = true; continue; }
    if (record.kind !== "frame") { continue; }
    const { type, events } = record.body;
    if (type === "tool_call" || type === "tool_call_update") { reset(true); continue; }
    if (type === "session/prompt") { reset(false); continue; }
    if (METADATA_FRAMES.has(type)) { continue; }
    if (type === "usage_update") {
      if (state.text.length > 0) { state.blocked = true; }
      continue;
    }
    if (type !== "agent_message_chunk") { state.blocked = true; continue; }
    const chunk = events.find(event => event.kind === "text_delta");
    if (chunk === undefined || state.text.length + chunk.text.length > 256) { state.blocked = true; continue; }
    state.text += chunk.text;
    state.receivedAt = record.receivedAt;
  }
  return state.blocked || (!state.priorTool && "usage" in response) ? null : quotaOutcome(state.text, state.receivedAt, true);
}
