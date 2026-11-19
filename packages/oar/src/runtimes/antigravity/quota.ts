import type { RawEvent, TurnOutcome } from "../../contracts/session.js";
import { acpErrorReason, rpcErrorCode } from "../../shared/acp/failure.js";
import { utcInstantFromDate } from "../../shared/instant.js";
import type { JsonRecord } from "../../shared/json.js";

// agy 1.5.12 Gemini account notice. The prompt error may wrap this sentence.
const QUOTA = /Individual quota reached\. Please upgrade your subscription to increase your limits\. Resets in (?=\d)(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?\./u;

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

/** Only native assistant text can constitute the entire notice. Metadata may accompany it. */
export function antigravityQuotaNotice(response: JsonRecord, turnRecords: () => readonly RawEvent[]): TurnOutcome | null {
  if (response.stopReason !== "end_turn" || "usage" in response) { return null; }
  let text = "";
  let receivedAt = 0;
  for (const record of turnRecords()) {
    if (record.kind === "request" && record.direction === "toApp") { return null; }
    if (record.kind !== "frame") { continue; }
    const { type, events } = record.body;
    if (["session_info_update", "usage_update", "config_option_update", "available_commands_update", "current_mode_update"].includes(type)) { continue; }
    if (type !== "agent_message_chunk") { return null; }
    const chunk = events.find(event => event.kind === "text_delta");
    if (chunk === undefined || text.length + chunk.text.length > 256) { return null; }
    text += chunk.text;
    receivedAt = record.receivedAt;
  }
  return quotaOutcome(text, receivedAt, true);
}
