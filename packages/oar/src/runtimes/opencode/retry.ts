import type { RuntimeEventBody } from "../../contracts/session.js";
import { asNumber, asRecord, type JsonRecord } from "../../shared/json.js";

/** A scheduled retry is announced once. A null marker clears it and a prompt result can repeat it. */
export function opencodeRetryEvents(update: JsonRecord, receivedAt: number): readonly RuntimeEventBody[] {
  if (update.sessionUpdate !== "session_info_update") { return []; }
  // oxlint-disable-next-line eslint/no-underscore-dangle -- OpenCode's native ACP metadata.
  const retry = asRecord(asRecord(update._meta)?.["opencode/retry"]);
  const attempt = asNumber(retry?.attempt);
  if (attempt === null || !Number.isSafeInteger(attempt) || attempt < 1) { return []; }
  const at = typeof retry?.nextRetryAt === "string" ? Date.parse(retry.nextRetryAt) : NaN;
  const category = asRecord(retry?.error)?.type;
  return [{ kind: "retry", attempt,
    ...(Number.isFinite(at) ? { delayMs: Math.max(0, at - receivedAt) } : {}),
    ...(typeof category === "string" && /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u.test(category) ? { reason: category } : {}),
  }];
}
