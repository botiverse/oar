import type { AccountUsageSnapshot, AccountUsageWindow } from "../../contracts/account-usage.js";
import { withQueryDeadline } from "../../shared/executable/query.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { remainingMs } from "../../shared/deadline.js";
import { utcInstantFromDate } from "../../shared/instant.js";
import { KIMI_USAGE, type KimiAuthContext } from "./auth-config.js";
import { readKimiToken } from "./oauth-token.js";
import { kimiWebRequest } from "./web-query.js";
import { startKimiWeb } from "./web-startup.js";

const buckets = { limit5h: "5h limit", limit7d: "Weekly limit", monthTotal: "Monthly limit", monthCode: "Monthly code limit" } as const;

/** These ratios and cents have already been parsed by Kimi's managed-usage service. */
export function projectKimiNativeUsage(quota: JsonRecord): AccountUsageSnapshot {
  const usages = asRecord(quota.usages);
  const windows: AccountUsageWindow[] = [];
  for (const [key, label] of Object.entries(buckets)) {
    const row = asRecord(usages?.[key]);
    if (typeof row?.usedRatio !== "number" || !Number.isFinite(row.usedRatio)) { continue; }
    const resetsAt = typeof row.resetAt === "string" ? utcInstantFromDate(new Date(row.resetAt)) : null;
    windows.push({ label, usedRatio: Math.max(0, Math.min(1, row.usedRatio)), scope: { kind: "account" }, ...(resetsAt === null ? {} : { resetsAt }) });
  }
  if (windows.length === 0) { throw new Error("Kimi usage response contains no usable quota windows"); }
  const subscriptionExhausted = windows.some(row => row.usedRatio === 1);
  const extra = asRecord(quota.extraUsage);
  const cap = extra?.monthlyChargeLimitEnabled === true && typeof extra.monthlyChargeLimitCents === "number" && Number.isFinite(extra.monthlyChargeLimitCents) && extra.monthlyChargeLimitCents > 0 ? extra.monthlyChargeLimitCents : undefined;
  const used = typeof extra?.monthlyUsedCents === "number" && Number.isFinite(extra.monthlyUsedCents) && extra.monthlyUsedCents >= 0 ? extra.monthlyUsedCents : undefined;
  if (cap !== undefined && used !== undefined) { windows.push({ label: "Extra Usage monthly limit", usedRatio: Math.max(0, Math.min(1, used / cap)), scope: { kind: "account" } }); }
  const headroom = typeof extra?.balanceCents === "number" && Number.isFinite(extra.balanceCents) && extra.balanceCents > 0
    && (extra.monthlyChargeLimitEnabled === false || (extra.monthlyChargeLimitEnabled === true && cap !== undefined && Number.isFinite(cap) && used !== undefined && Number.isFinite(used) && used >= 0 && used < cap));
  return { kind: "available", windows, rateLimited: subscriptionExhausted && !headroom };
}

async function failure(payload: JsonRecord, auth: KimiAuthContext): Promise<AccountUsageSnapshot> {
  if (payload.status === 401 || payload.status === 403) { return { kind: "reauth_required", reason: "credentials_rejected" }; }
  if (payload.status === 404) { return { kind: "unsupported", reason: "endpoint_unavailable" }; }
  // Native refresh failures discard the HTTP status. Only its persisted revoked
  // marker or a missing credential establishes reauthentication; never parse prose.
  const token = await readKimiToken(auth);
  if (token === undefined) { return { kind: "reauth_required", reason: "credentials_missing" }; }
  if (token.revoked) { return { kind: "reauth_required", reason: "credentials_rejected" }; }
  throw new Error("Kimi native usage query failed");
}

export async function kimiNativeUsage(command: string, auth: KimiAuthContext, env: NodeJS.ProcessEnv, deadline: number): Promise<AccountUsageSnapshot> {
  const snapshot = await withQueryDeadline(KIMI_USAGE, remainingMs(deadline, KIMI_USAGE), async signal => {
    const { child, web } = await startKimiWeb(command, env, signal);
    try {
      const payload = await kimiWebRequest(web, signal, "/oauth/usage");
      if (payload.kind === "error") { return await failure(payload, auth); }
      const quota = asRecord(payload.quota);
      if (payload.kind !== "ok" || quota === null) { throw new Error("Kimi native usage response is malformed"); }
      const result = projectKimiNativeUsage(quota);
      // Profile lookup is best effort and uses the same native refresh owner.
      const profile = await kimiWebRequest(web, signal, "/oauth/userinfo").catch(() => null);
      const user = profile?.kind === "ok" ? asRecord(profile.userInfo) : null;
      if (result.kind !== "available" || user === null) { return result; }
      return { ...result, ...(typeof user.email === "string" && user.email.length > 0 ? { email: user.email } : {}),
        ...(typeof user.nickname === "string" && user.nickname.length > 0 ? { displayName: user.nickname } : {}),
        ...(typeof user.userLevelName === "string" && user.userLevelName.length > 0 ? { plan: user.userLevelName } : {}) };
    } finally { if (!child.stopping()) { child.kill(); } await child.exited; }
  });
  return snapshot;
}
