import type { AccountLimitReset, AccountLimitResets, LimitResetResult } from "../../contracts/account-usage.js";
import { asEpochInstant, asNumber, asRecord, asRecordList } from "../../shared/json.js";

const STATUSES: Readonly<Record<string, AccountLimitReset["status"]>> = {
  available: "available",
  redeeming: "redeeming",
  redeemed: "redeemed",
};

function limitReset(credit: Record<string, unknown>): AccountLimitReset | undefined {
  // A reset of another kind would not reset these limits; Codex names only one.
  if (typeof credit.id !== "string" || credit.id.length === 0 || credit.resetType !== "codexRateLimits") {
    return undefined;
  }
  const status = typeof credit.status === "string" && Object.hasOwn(STATUSES, credit.status) ? STATUSES[credit.status] : undefined;
  const grantedAt = asEpochInstant(credit.grantedAt);
  const expiresAt = asEpochInstant(credit.expiresAt);
  const title = typeof credit.title === "string" ? credit.title : undefined;
  const description = typeof credit.description === "string" ? credit.description : undefined;
  return {
    id: credit.id,
    status: status ?? "unknown",
    ...(grantedAt === null ? {} : { grantedAt }),
    ...(expiresAt === null ? {} : { expiresAt }),
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
  };
}

/**
 * `rateLimitResetCredits` on `account/rateLimits/read`: `{ "availableCount": 1,
 * "credits": [{ "id": "credit-1", "resetType": "codexRateLimits",
 * "status": "available", "grantedAt": 1794000000, "expiresAt": null,
 * "title": null, "description": null }] }`. `credits: null` means Codex gave
 * only the count.
 */
export function projectLimitResets(summary: unknown): AccountLimitResets | undefined {
  const root = asRecord(summary);
  const available = asNumber(root?.availableCount);
  if (root === null || available === null || !Number.isInteger(available) || available < 0) {
    return undefined;
  }
  if (!Array.isArray(root.credits)) {
    return { available };
  }
  const resets = asRecordList(root.credits).flatMap((credit) => limitReset(credit) ?? []);
  return { available, resets };
}

/** Codex's own outcomes for `account/rateLimitResetCredit/consume`. */
const OUTCOMES: Readonly<Record<string, LimitResetResult>> = {
  reset: { kind: "reset" },
  nothingToReset: { kind: "nothing_to_reset" },
  noCredit: { kind: "no_reset" },
  alreadyRedeemed: { kind: "already_redeemed" },
};

/**
 * The answer to `account/rateLimitResetCredit/consume`: `{ "outcome": "reset" }`.
 * Source: https://github.com/openai/codex/blob/d7de4dd3ac3e4c489368c3985013e78622496962/codex-rs/app-server/src/request_processors/account_processor/rate_limit_resets.rs
 */
export function projectLimitResetOutcome(result: unknown): LimitResetResult {
  const outcome = asRecord(result)?.outcome;
  const known = typeof outcome === "string" && Object.hasOwn(OUTCOMES, outcome) ? OUTCOMES[outcome] : undefined;
  if (known === undefined) {
    throw new Error("Codex returned no known limit reset outcome");
  }
  return known;
}
