import type { SessionOptions } from "../../contracts/session-options.js";
import type {
  AccountUsageReader,
  AccountUsageSnapshot,
  AccountUsageWindow,
} from "../../contracts/account-usage.js";
import { callAppServer, type ReadOutcome, type StartAppServerClient } from "./account-request.js";
import { startAppServerClient } from "./app-server-client.js";
import { asEpochInstant, asNumber, asRecord } from "../../shared/json.js";
import { projectLimitResets } from "./reset-credits.js";

function text(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 80 ? trimmed : undefined;
}

function windowLabel(value: unknown): string {
  const minutes = asNumber(value);
  if (minutes === null || minutes <= 0) {
    return "Usage limit";
  }
  if (minutes % (7 * 24 * 60) === 0) {
    const weeks = minutes / (7 * 24 * 60);
    return `${weeks} ${weeks === 1 ? "week" : "weeks"}`;
  }
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${minutes} minutes`;
}

function limitLabel(bucket: Record<string, unknown>): string | undefined {
  const name = text(bucket.limitName);
  if (name !== undefined) {
    return name;
  }
  const id = text(bucket.limitId);
  return id === "codex" ? "Codex" : id;
}

/**
 * Mirrors Codex TUI's `app_server_rate_limit_snapshots` merge and deduplication.
 * Source (2026-08-22):
 * https://github.com/openai/codex/blob/4f39251a010a8bd7d692d25fb33832ff06f1635a/codex-rs/tui/src/app_server_session.rs#L2084-L2103
 */
function rateLimitBuckets(
  historical: Record<string, unknown> | null,
  indexed: Record<string, unknown> | null,
): Record<string, unknown>[] {
  const primaryLimitId = text(historical?.limitId);
  const buckets = historical === null ? [] : [historical];
  if (indexed === null) {
    return buckets;
  }
  for (const [limitId, value] of Object.entries(indexed)) {
    const bucket = asRecord(value);
    if (bucket === null) {
      continue;
    }
    if (primaryLimitId !== undefined
      && (primaryLimitId === limitId || primaryLimitId === text(bucket.limitId))) {
      continue;
    }
    buckets.push(bucket);
  }
  return buckets;
}

/**
 * Native evidence comes from `codex app-server --listen stdio://`, followed by
 * `initialize` and `account/rateLimits/read`. `rateLimits` is the
 * backward-compatible single-bucket view; `rateLimitsByLimitId` is the
 * optional multi-bucket view. A representative response is:
 *
 * ```json
 * {
 *   "rateLimits": {
 *     "limitId": "codex",
 *     "limitName": null,
 *     "primary": { "usedPercent": 50, "windowDurationMins": 10080, "resetsAt": 1787820410 },
 *     "secondary": null,
 *     "planType": "pro",
 *     "rateLimitReachedType": null
 *   },
 *   "rateLimitsByLimitId": {
 *     "codex_bengalfox": {
 *       "limitId": "codex_bengalfox",
 *       "limitName": "GPT-5.3-Codex-Spark",
 *       "primary": { "usedPercent": 0, "windowDurationMins": 300, "resetsAt": 1787322278 },
 *       "secondary": { "usedPercent": 0, "windowDurationMins": 10080, "resetsAt": 1787909078 },
 *       "planType": "pro"
 *     },
 *     "codex": {
 *       "limitId": "codex",
 *       "limitName": null,
 *       "primary": { "usedPercent": 50, "windowDurationMins": 10080, "resetsAt": 1787820410 },
 *       "secondary": null,
 *       "planType": "pro",
 *       "rateLimitReachedType": null
 *     }
 *   }
 * }
 * ```
 */
export function projectCodexUsage(result: unknown, email?: string): AccountUsageSnapshot {
  const root = asRecord(result);
  const historical = asRecord(root?.rateLimits);
  const indexed = asRecord(root?.rateLimitsByLimitId);
  const buckets = rateLimitBuckets(historical, indexed);
  const windows: AccountUsageWindow[] = [];
  let rateLimited = false;
  let plan: string | undefined = undefined;

  for (const bucket of buckets) {
    const sourceLabel = limitLabel(bucket);
    plan ??= text(bucket.planType);
    rateLimited ||= bucket.rateLimitReachedType !== null
      && bucket.rateLimitReachedType !== undefined;

    for (const kind of ["primary", "secondary"] as const) {
      const candidate = asRecord(bucket[kind]);
      if (candidate === null) {
        continue;
      }
      const usedPercent = asNumber(candidate.usedPercent);
      if (usedPercent === null || usedPercent < 0 || usedPercent > 100) {
        continue;
      }
      const resetsAt = asEpochInstant(candidate.resetsAt);
      const durationLabel = windowLabel(candidate.windowDurationMins);
      const minutes = asNumber(candidate.windowDurationMins);
      const limitId = text(bucket.limitId);
      windows.push({
        label: sourceLabel === undefined ? durationLabel : `${sourceLabel} · ${durationLabel}`,
        usedRatio: Number((usedPercent / 100).toFixed(6)),
        ...(resetsAt === null ? {} : { resetsAt }),
        ...(limitId === undefined ? {} : { id: `${limitId}:${kind}` }),
        ...(minutes === null || minutes <= 0 ? {} : { durationMs: minutes * 60_000 }),
      });
      rateLimited ||= usedPercent >= 100;
    }
  }

  if (windows.length === 0) {
    throw new Error("Codex returned no usable account usage windows");
  }
  const limitResets = projectLimitResets(root?.rateLimitResetCredits);
  return {
    kind: "available",
    ...(plan === undefined ? {} : { plan }),
    ...(email === undefined ? {} : { email }),
    rateLimited,
    windows,
    ...(limitResets === undefined ? {} : { limitResets }),
  };
}

export async function readFromAppServer(
  command: string,
  timeoutMs: number,
  startClient: StartAppServerClient = startAppServerClient,
  env?: SessionOptions["env"],
  limitResetDetails = true,
): Promise<ReadOutcome> {
  // Older app-servers take this read with no params and refuse any field;
  // they report no reset credits either, so the bare read loses nothing.
  const params = limitResetDetails ? {} : { excludeResetCreditDetails: true };
  const outcome = await callAppServer(command, timeoutMs, { method: "account/rateLimits/read", params, legacyParams: {} }, startClient, env);
  return outcome;
}


export const codexAccountUsage: AccountUsageReader = async (installation, options = {}) => {
  if (installation.via !== "executable") {
    return { kind: "unsupported", reason: "unsupported_installation" };
  }
  const outcome = await readFromAppServer(installation.command, options.timeoutMs ?? 8000, undefined, options.env, options.limitResetDetails ?? true);
  switch (outcome.kind) {
    case "ok":
      return projectCodexUsage(outcome.result, outcome.email);
    case "reauth_required":
      return outcome;
    case "unsupported":
      return outcome;
    case "error":
      break;
  }
  throw new Error("Failed to read Codex account usage");
};
