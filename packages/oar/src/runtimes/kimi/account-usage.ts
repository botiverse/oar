import type {
  AccountUsageReader,
  AccountUsageSnapshot,
  AccountUsageWindow,
  UtcInstant,
} from "../../contracts/account-usage.js";
import { utcInstantFromDate } from "../../shared/instant.js";
import { asNumber, asRecord, parseJson } from "../../shared/json.js";
import { kimiRemainingMs, resolveKimiAuth, type KimiAuthContext } from "./auth-config.js";
import { freshKimiAccessToken, KimiReauthError } from "./oauth-token.js";

interface UsageWindowSpec {
  readonly duration: number;
  readonly unit: "minute" | "hour" | "day" | "week";
}

interface UsageRow {
  readonly name?: string;
  readonly window?: UsageWindowSpec;
  readonly used: number;
  readonly limit: number;
  readonly resetsAt?: UtcInstant;
}

interface BoosterWallet {
  readonly balance: number;
  readonly monthlyLimit: number | null;
  readonly monthlyUsed: number;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function numeric(value: unknown): number | null {
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }
  const parsed = asNumber(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function resetInstant(value: unknown): UtcInstant | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return utcInstantFromDate(new Date(value)) ?? undefined;
}

function usageUnit(value: unknown): UsageWindowSpec["unit"] | undefined {
  switch (value) {
    case "TIME_UNIT_MINUTE":
      return "minute";
    case "TIME_UNIT_HOUR":
      return "hour";
    case "TIME_UNIT_DAY":
      return "day";
    case "TIME_UNIT_WEEK":
      return "week";
    default:
      return undefined;
  }
}

function usageWindow(value: unknown): UsageWindowSpec | undefined {
  const record = asRecord(value);
  const duration = numeric(record?.duration);
  const unit = usageUnit(record?.timeUnit);
  if (duration === null || duration <= 0 || unit === undefined) {
    return undefined;
  }
  if (unit === "minute" && duration >= 60 && duration % 60 === 0) {
    return { duration: duration / 60, unit: "hour" };
  }
  return { duration, unit };
}

function usageRow(
  value: unknown,
  extra: { readonly name?: string; readonly window?: UsageWindowSpec } = {},
): UsageRow | null {
  const record = asRecord(value);
  const used = numeric(record?.used);
  const limit = numeric(record?.limit);
  if (used === null && limit === null) {
    return null;
  }
  const name = extra.name ?? text(record?.name);
  const resetsAt = resetInstant(record?.resetTime);
  return {
    ...(name === undefined ? {} : { name }),
    ...(extra.window === undefined ? {} : { window: extra.window }),
    used: used ?? 0,
    limit: limit ?? 0,
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

function usageLabel(row: UsageRow): string {
  const window = row.window;
  if (window !== undefined) {
    if (window.unit === "week") {
      return "Weekly limit";
    }
    return `${window.duration}${window.unit.charAt(0)} limit`;
  }
  return row.name ?? "Limit";
}

function projectWindow(row: UsageRow): AccountUsageWindow | null {
  if (row.limit <= 0 || row.used < 0) {
    return null;
  }
  return {
    label: usageLabel(row),
    usedRatio: Number(Math.max(0, Math.min(1, row.used / row.limit)).toFixed(6)),
    ...(row.resetsAt === undefined ? {} : { resetsAt: row.resetsAt }),
  };
}

function moneyCents(value: unknown): number | null {
  const cents = numeric(asRecord(value)?.priceInCents);
  return cents === null || cents < 0 ? null : cents;
}

function boosterWallet(value: unknown): BoosterWallet | null {
  const record = asRecord(value);
  const balance = asRecord(record?.balance);
  const total = numeric(balance?.amount);
  if (balance?.type !== "BOOSTER" || total === null || total <= 0) {
    return null;
  }
  const amountLeft = numeric(balance.amountLeft) ?? 0;
  const limit = record?.monthlyChargeLimitEnabled === true
    ? moneyCents(record.monthlyChargeLimit)
    : null;
  return {
    balance: Math.max(0, amountLeft),
    monthlyLimit: limit !== null && limit > 0 ? limit : null,
    monthlyUsed: moneyCents(record?.monthlyUsed) ?? 0,
  };
}

/** Project the same managed quota rows that Kimi Code 0.38.0 renders in `/usage`. */
export function projectKimiUsage(payload: unknown): AccountUsageSnapshot {
  const root = asRecord(payload);
  const rows: UsageRow[] = [];
  const summary = usageRow(root?.usage, { window: { duration: 1, unit: "week" } });
  if (summary !== null) {
    rows.push(summary);
  }
  const limits = root?.limits;
  if (Array.isArray(limits)) {
    for (const value of limits) {
      const limit = asRecord(value);
      const name = text(limit?.name);
      const window = usageWindow(limit?.window);
      const row = usageRow(limit?.detail, {
        ...(name === undefined ? {} : { name }),
        ...(window === undefined ? {} : { window }),
      });
      if (row !== null) {
        rows.push(row);
      }
    }
  }
  const windows = rows
    .map((row) => projectWindow(row))
    .filter((window): window is AccountUsageWindow => window !== null);
  const extraUsage = boosterWallet(root?.boosterWallet);
  if (extraUsage?.monthlyLimit !== null && extraUsage?.monthlyLimit !== undefined) {
    windows.push({
      label: "Extra Usage monthly limit",
      usedRatio: Number(Math.min(1, extraUsage.monthlyUsed / extraUsage.monthlyLimit).toFixed(6)),
    });
  }
  // Kimi's Extra Usage balance bypasses exhausted weekly/hourly subscription
  // quotas. A configured monthly spending cap is the only additional blocker.
  const extraUsageHeadroom = extraUsage !== null
    && extraUsage.balance > 0
    && (extraUsage.monthlyLimit === null || extraUsage.monthlyUsed < extraUsage.monthlyLimit);
  return {
    kind: "available",
    rateLimited: rows.some((row) => projectWindow(row)?.usedRatio === 1) && !extraUsageHeadroom,
    windows,
  };
}

async function fetchUsage(
  auth: KimiAuthContext,
  accessToken: string,
  deadline: number,
): Promise<Response> {
  try {
    return await fetch(`${auth.baseUrl}/usages`, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(kimiRemainingMs(deadline)),
    });
  } catch (error) {
    throw new Error("Failed to reach Kimi usage endpoint", { cause: error });
  }
}

export const kimiAccountUsage: AccountUsageReader = async (installation, options = {}) => {
  if (installation.via !== "executable") {
    return { kind: "unsupported" };
  }
  // Kimi's Node launcher is measurably slow under the behavior suite's
  // concurrent process load; match the runtime probe/session budget.
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  const auth = await resolveKimiAuth(installation.command, deadline);
  if (auth === null || auth.storage !== "file") {
    return { kind: "unsupported" };
  }
  try {
    const accessToken = await freshKimiAccessToken(auth, installation.version, deadline);
    const response = await fetchUsage(auth, accessToken, deadline);
    if (response.status === 401 || response.status === 403) {
      return { kind: "reauth_required" };
    }
    if (response.status === 404) {
      return { kind: "unsupported" };
    }
    if (!response.ok) {
      throw new Error(`Kimi usage endpoint returned HTTP ${response.status}`);
    }
    return projectKimiUsage(parseJson(await response.text()));
  } catch (error) {
    if (error instanceof KimiReauthError) {
      return { kind: "reauth_required" };
    }
    throw new Error("Failed to read Kimi account usage", { cause: error });
  }
};
