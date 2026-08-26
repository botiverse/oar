import type {
  AccountUsageReader,
  AccountUsageSnapshot,
  AccountUsageWindow,
  UtcInstant,
} from "../../contracts/account-usage.js";
import { runExecutable } from "../../shared/executable/index.js";
import { utcInstantFromDate } from "../../shared/instant.js";
import { asRecord, parseJson } from "../../shared/json.js";

const MONTHS = new Map([
  ["Jan", 0], ["Feb", 1], ["Mar", 2], ["Apr", 3], ["May", 4], ["Jun", 5],
  ["Jul", 6], ["Aug", 7], ["Sep", 8], ["Oct", 9], ["Nov", 10], ["Dec", 11],
]);

interface LocalDateTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

function zonedParts(instant: number, timeZone: string): LocalDateTime | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const result = {
      year: Number(values.year),
      month: Number(values.month) - 1,
      day: Number(values.day),
      hour: Number(values.hour),
      minute: Number(values.minute),
    };
    return Object.values(result).every((value) => Number.isFinite(value)) ? result : null;
  } catch {
    return null;
  }
}

function localInstant(value: LocalDateTime, timeZone: string): number | null {
  const target = Date.UTC(value.year, value.month, value.day, value.hour, value.minute);
  let instant = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = zonedParts(instant, timeZone);
    if (observed === null) {
      return null;
    }
    const correction = target
      - Date.UTC(observed.year, observed.month, observed.day, observed.hour, observed.minute);
    if (correction === 0) {
      return instant;
    }
    instant += correction;
  }
  return null;
}

function resetInstant(resetText: string, referenceInstant: Date): UtcInstant | null {
  const match = /^(\w{3}) (\d{1,2}) at (\d{1,2}):(\d{2})(am|pm) \(([^)]+)\)$/u.exec(resetText);
  const month = MONTHS.get(match?.[1] ?? "");
  const day = Number(match?.[2]);
  const twelveHour = Number(match?.[3]);
  const minute = Number(match?.[4]);
  const meridiem = match?.[5];
  const timeZone = match?.[6];
  if (month === undefined || timeZone === undefined || day < 1 || day > 31
    || twelveHour < 1 || twelveHour > 12 || minute < 0 || minute > 59
    || (meridiem !== "am" && meridiem !== "pm")) {
    return null;
  }
  const reference = zonedParts(referenceInstant.getTime(), timeZone);
  if (reference === null) {
    return null;
  }
  const hour = twelveHour % 12 + (meridiem === "pm" ? 12 : 0);
  const cutoff = referenceInstant.getTime() - 60_000;
  for (const year of [reference.year, reference.year + 1]) {
    const instant = localInstant({ year, month, day, hour, minute }, timeZone);
    if (instant !== null && instant >= cutoff) {
      return utcInstantFromDate(new Date(instant));
    }
  }
  return null;
}

function resultText(stdout: string): string | null {
  const result = asRecord(parseJson(stdout))?.result;
  return typeof result === "string" && result.trim().length > 0 ? result : null;
}

export function projectClaudeUsage(
  content: string,
  referenceInstant: Date = new Date(),
  email?: string,
): AccountUsageSnapshot {
  const windows: AccountUsageWindow[] = [];
  for (const line of content.split(/\r?\n/u)) {
    const match = /^(.+?): (\d+(?:\.\d+)?)% used(?: · resets (.+))?$/u.exec(line.trim());
    const label = match?.[1];
    const percentage = match?.[2];
    if (label === undefined || percentage === undefined) {
      continue;
    }
    const usedPercent = Number(percentage);
    if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) {
      continue;
    }
    const resetText = match?.[3];
    const resetsAt = resetText === undefined ? null : resetInstant(resetText, referenceInstant);
    windows.push({
      label,
      usedRatio: Number((usedPercent / 100).toFixed(6)),
      ...(resetsAt === null ? {} : { resetsAt }),
    });
  }
  if (windows.length === 0) {
    throw new Error("Claude returned no usable account usage windows");
  }
  return {
    kind: "available",
    ...(email === undefined ? {} : { email }),
    rateLimited: windows.some((window) => window.usedRatio >= 1),
    windows,
  };
}

/**
 * `claude -p /usage --output-format json` has two observed shapes.
 * Without login, `result` is only an invocation summary:
 *
 * ```json
 * {
 *   "type": "result",
 *   "total_cost_usd": 0,
 *   "usage": { "input_tokens": 0, "output_tokens": 0 },
 *   "result": "Total cost: $0.0000\nUsage: 0 input, 0 output, 0 cache read, 0 cache write"
 * }
 * ```
 *
 * With a subscription login, `result` contains account usage windows:
 *
 * ```json
 * {
 *   "type": "result",
 *   "result": "You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 7% used · resets Aug 21 at 7:39pm (Asia/Shanghai)\nCurrent week (all models): 0% used · resets Aug 28 at 2:59pm (Asia/Shanghai)\nCurrent week (Fable): 0% used"
 * }
 * ```
 *
 * Reset text has no year, so it is interpreted as the next occurrence in its
 * named IANA time zone relative to when the command result is projected.
 */
export const claudeAccountUsage: AccountUsageReader = async (installation, options = {}) => {
  if (installation.via !== "executable") {
    return { kind: "unsupported" };
  }
  const command = installation.command;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const env = { ...process.env, CLAUDECODE: undefined };
  const auth = await runExecutable(command, ["auth", "status", "--json"], { env, timeoutMs });
  if (!auth.ok && auth.exitCode === null) {
    throw new Error("Failed to read Claude authentication status");
  }
  const authStatus = asRecord(parseJson(auth.stdout));
  if (!auth.ok || authStatus?.loggedIn === false) {
    return { kind: "reauth_required" };
  }
  // Only a confirmed login exposes an account email (pinned by the owner's
  // `loggedIn === true` requirement); an absent or non-string email is dropped.
  const email = authStatus?.loggedIn === true && typeof authStatus.email === "string"
    ? authStatus.email
    : undefined;
  if (typeof authStatus?.apiKeySource === "string") {
    // An API key takes precedence over any claude.ai login, and API-key
    // billing has no subscription usage windows — /usage would return only a
    // cost report (pinned by the claude vendor usage test).
    return { kind: "unsupported" };
  }

  const usage = await runExecutable(command, ["-p", "/usage", "--output-format", "json"], {
    env,
    timeoutMs,
  });
  if (!usage.ok && usage.exitCode === null) {
    throw new Error("Failed to execute Claude account usage");
  }
  if (!usage.ok) {
    const output = `${usage.stdout}\n${usage.stderr}`;
    if (/auth(?:entication)?\s*(?:missing|required)|log(?:ged)?\s*in/iu.test(output)) {
      return { kind: "reauth_required" };
    }
    throw new Error("Claude account usage command failed");
  }
  const content = resultText(usage.stdout);
  if (content === null) {
    throw new Error("Claude returned no account usage result");
  }
  return projectClaudeUsage(content, new Date(), email);
};
