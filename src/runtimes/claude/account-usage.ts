import type {
  AccountUsage,
  AccountUsageHealth,
  AccountUsageReadOptions,
  AccountUsageSnapshot,
  AccountUsageWindow,
} from "../../contracts/account-usage.js";
import {
  ACCOUNT_USAGE_PROTOCOL_VERSION,
  unsupportedAccountUsage,
} from "../../contracts/account-usage.js";
import { resolveCommand, runCommand } from "../../shared/command/index.js";
import { sha256Hex } from "../../shared/hash.js";

function accountKey(localAccountSlot: string): string {
  return sha256Hex(`claude\0${localAccountSlot}`);
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

function resetAt(value: string, observedAtMs: number): string | undefined {
  const match = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})(?:,| at) (\d{1,2})(?::(\d{2}))?(am|pm) \(UTC\)$/iu.exec(value.trim());
  if (match === null) return undefined;
  const monthName = match[1];
  const dayText = match[2];
  const hourText = match[3];
  const period = match[5];
  if (monthName === undefined || dayText === undefined || hourText === undefined || period === undefined) {
    return undefined;
  }
  const month = MONTHS.map(String).indexOf(monthName);
  let hour = Number(hourText);
  if (period.toLowerCase() === "pm" && hour !== 12) hour += 12;
  if (period.toLowerCase() === "am" && hour === 12) hour = 0;
  const observed = new Date(observedAtMs);
  let instant = Date.UTC(
    observed.getUTCFullYear(),
    month,
    Number(dayText),
    hour,
    Number(match[4] ?? 0),
  );
  if (instant <= observedAtMs) {
    instant = Date.UTC(observed.getUTCFullYear() + 1, month, Number(dayText), hour, Number(match[4] ?? 0));
  }
  return new Date(instant).toISOString();
}

function windowId(label: string): string {
  if (label === "Current session") return "current_session";
  if (label === "Current week (all models)") return "current_week_all_models";
  return label.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "_").replaceAll(/^_|_$/gu, "");
}

export function projectClaudeUsage(
  content: string,
  options: Required<Pick<AccountUsageReadOptions, "collectorVersion" | "localAccountSlot" | "observedAtMs">>,
): AccountUsageSnapshot {
  const windows: AccountUsageWindow[] = [];
  for (const line of content.split(/\r?\n/u)) {
    const match = /^(Current session|Current week \([^)]+\)): (\d+(?:\.\d+)?)% used · resets (.+)$/u.exec(line.trim());
    const label = match?.[1];
    const percentage = match?.[2];
    const resetText = match?.[3];
    if (label === undefined || percentage === undefined || resetText === undefined) continue;
    const usedPercent = Number(percentage);
    const resetsAt = resetAt(resetText, options.observedAtMs);
    const complete = Number.isFinite(usedPercent) && usedPercent >= 0 && usedPercent <= 100
      && resetsAt !== undefined;
    windows.push({
      id: windowId(label),
      label,
      status: complete ? (usedPercent >= 100 ? "limit_reached" : "ok") : "parse_unavailable",
      acquisition: "text_parse",
      ...(complete ? { usedRatio: Number((usedPercent / 100).toFixed(6)), resetsAt } : {}),
    });
  }
  if (windows.length === 0) {
    windows.push({
      id: "usage_unavailable",
      label: "Usage limit",
      status: "parse_unavailable",
      acquisition: "text_parse",
    });
  }
  return {
    protocolVersion: ACCOUNT_USAGE_PROTOCOL_VERSION,
    runtime: "claude",
    collectedAt: new Date(options.observedAtMs).toISOString(),
    staleAfter: new Date(options.observedAtMs + 15 * 60_000).toISOString(),
    acquisition: "text_parse",
    scope: "local_sessions_only",
    collectorVersion: options.collectorVersion,
    sourceVersion: "claude -p /usage rendered text (approximate; local sessions only)",
    accounts: [{
      accountKey: accountKey(options.localAccountSlot),
      health: windows.some((window) => window.status === "limit_reached") ? "rate_limited" : "ok",
      healthAcquisition: "text_parse",
      healthObservedAt: new Date(options.observedAtMs).toISOString(),
      ...(windows.some((window) => window.status === "parse_unavailable")
        ? { parseErrorCode: "claude_usage_text_incomplete" }
        : {}),
      windows,
    }],
  };
}

function statusSnapshot(
  health: Extract<AccountUsageHealth, "reauth_required" | "error">,
  options: Required<Pick<AccountUsageReadOptions, "collectorVersion" | "localAccountSlot" | "observedAtMs">>,
): AccountUsageSnapshot {
  return {
    protocolVersion: ACCOUNT_USAGE_PROTOCOL_VERSION,
    runtime: "claude",
    collectedAt: new Date(options.observedAtMs).toISOString(),
    staleAfter: new Date(options.observedAtMs + 5 * 60_000).toISOString(),
    acquisition: "text_parse",
    scope: "local_sessions_only",
    collectorVersion: options.collectorVersion,
    accounts: [{
      accountKey: accountKey(options.localAccountSlot),
      health,
      healthAcquisition: "text_parse",
      healthObservedAt: new Date(options.observedAtMs).toISOString(),
      windows: [],
    }],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsedResult(stdout: string): string | null {
  try {
    const value: unknown = JSON.parse(stdout);
    if (!isRecord(value)) return null;
    const result = value.result;
    return typeof result === "string" && result.trim().length > 0 ? result : null;
  } catch {
    return null;
  }
}

export function createClaudeAccountUsage(): AccountUsage {
  return {
    async read(input = {}): Promise<AccountUsageSnapshot> {
      const options = {
        collectorVersion: input.collectorVersion ?? "oar-0.0.0",
        localAccountSlot: input.localAccountSlot ?? "local",
        observedAtMs: input.observedAtMs ?? Date.now(),
      };
      const command = resolveCommand("claude");
      if (command === null) {
        return unsupportedAccountUsage({
          runtime: "claude",
          collectorVersion: options.collectorVersion,
          observedAtMs: options.observedAtMs,
          accountKey: accountKey(options.localAccountSlot),
          sourceVersion: "claude executable not found",
        });
      }
      const timeoutMs = input.timeoutMs ?? 15_000;
      const env = { ...process.env, CLAUDECODE: undefined };
      const auth = await runCommand(command, ["auth", "status", "--json"], { env, timeoutMs });
      if (/"loggedIn"\s*:\s*false/iu.test(auth.stdout)) {
        return statusSnapshot("reauth_required", options);
      }
      const usage = await runCommand(command, ["-p", "/usage", "--output-format", "json"], {
        env,
        timeoutMs,
      });
      if (!usage.ok) {
        const output = `${usage.stdout}\n${usage.stderr}`;
        return statusSnapshot(
          /auth(?:entication)?\s*(?:missing|required)|log(?:ged)?\s*in/iu.test(output)
            ? "reauth_required"
            : "error",
          options,
        );
      }
      const result = parsedResult(usage.stdout);
      return result === null ? statusSnapshot("error", options) : projectClaudeUsage(result, options);
    },
  };
}
