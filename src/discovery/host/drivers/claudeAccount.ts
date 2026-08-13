/**
 * Claude Code usage via CLI text probe (raft `readClaudeUsageText` shape).
 *
 * 1) `claude auth status --json` → loggedIn
 * 2) `claude -p /usage --output-format json` → result string with limit lines
 *
 * Sample /usage result lines (historical form, still parsed when present):
 * ```
 * Current session: 12% used · resets Mar 3, 3:40pm (UTC)
 * Current week (all models): 45% used · resets Mar 9, 12am (UTC)
 * ```
 * Newer builds may emit a free-form summary without % lines — then windows
 * are parse_unavailable (not invented 0%).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { which } from "../probe.js";
import type { AccountUsageHealth, AccountUsageSnapshot, AccountUsageWindow } from "../../accountUsage.js";
import { ACCOUNT_USAGE_PROTOCOL_VERSION } from "../../accountUsage.js";

export type ClaudeUsageReadOutcome =
  | { kind: "ok"; text: string }
  | { kind: "reauth_required" }
  | { kind: "unsupported" }
  | { kind: "error" };

/** Default slot for oar-standalone callers; daemon swap adapter injects its slockHome. */
const DEFAULT_LOCAL_ACCOUNT_SLOT = "local";

function accountKey(localAccountSlot: string): string {
  return createHash("sha256").update(`claude\0${localAccountSlot}`).digest("hex");
}

function resolveClaudeBin(): string | null {
  // Prefer unaliased PATH entry; spawn does not expand shell aliases.
  return which("claude");
}

function runClaude(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ error: Error | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, CLAUDECODE: undefined },
      },
      (error, stdout, stderr) => {
        resolve({
          error: error ?? null,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      },
    );
  });
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * Best-effort parse of Claude /usage human reset strings.
 * Formats seen:
 * - `Mar 3, 3:40pm (UTC)` (older)
 * - `Aug 10 at 10:30pm (America/Chicago)` (current)
 * Timezone names are not fully resolved without a TZ DB — we only accept UTC
 * for a real ISO instant; other zones omit resetsAt (window → incomplete).
 */
function resetAtFromText(value: string, observedAtMs: number): string | null {
  const raw = value.trim();
  // Older: "Mar 3, 3:40pm (UTC)"
  const utcComma =
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{1,2})(?::(\d{2}))?(am|pm) \(UTC\)$/i.exec(
      raw,
    );
  if (utcComma) {
    const month = MONTHS.indexOf(utcComma[1]! as (typeof MONTHS)[number]);
    let hour = Number(utcComma[3]);
    if (utcComma[5]!.toLowerCase() === "pm" && hour !== 12) hour += 12;
    if (utcComma[5]!.toLowerCase() === "am" && hour === 12) hour = 0;
    const observed = new Date(observedAtMs);
    let reset = Date.UTC(
      observed.getUTCFullYear(),
      month,
      Number(utcComma[2]),
      hour,
      Number(utcComma[4] ?? 0),
    );
    if (reset <= observedAtMs) {
      reset = Date.UTC(
        observed.getUTCFullYear() + 1,
        month,
        Number(utcComma[2]),
        hour,
        Number(utcComma[4] ?? 0),
      );
    }
    return new Date(reset).toISOString();
  }
  // Current: "Aug 10 at 10:30pm (America/Chicago)" — only trustworthy when zone is UTC
  const atForm =
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}) at (\d{1,2})(?::(\d{2}))?(am|pm) \(([^)]+)\)$/i.exec(
      raw,
    );
  if (atForm && /^UTC$/i.test(atForm[6]!)) {
    const month = MONTHS.indexOf(atForm[1]! as (typeof MONTHS)[number]);
    let hour = Number(atForm[3]);
    if (atForm[5]!.toLowerCase() === "pm" && hour !== 12) hour += 12;
    if (atForm[5]!.toLowerCase() === "am" && hour === 12) hour = 0;
    const observed = new Date(observedAtMs);
    let reset = Date.UTC(
      observed.getUTCFullYear(),
      month,
      Number(atForm[2]),
      hour,
      Number(atForm[4] ?? 0),
    );
    if (reset <= observedAtMs) {
      reset = Date.UTC(
        observed.getUTCFullYear() + 1,
        month,
        Number(atForm[2]),
        hour,
        Number(atForm[4] ?? 0),
      );
    }
    return new Date(reset).toISOString();
  }
  // Non-UTC human zones: refuse to invent a timestamp (HaoHao: silent wrong > missing).
  return null;
}

function windowId(label: string): string {
  if (label === "Current session") return "current_session";
  if (label === "Current week (all models)") return "current_week_all_models";
  return `current_week_${createHash("sha256").update(label).digest("hex").slice(0, 12)}`;
}

/** Pure parse of /usage result text. */
export function projectClaudeUsageTextSnapshot(input: {
  text: string;
  collectorVersion: string;
  observedAtMs: number;
  localAccountSlot?: string;
}): AccountUsageSnapshot {
  const localAccountSlot = input.localAccountSlot ?? DEFAULT_LOCAL_ACCOUNT_SLOT;
  const windows: AccountUsageWindow[] = [];
  for (const line of input.text.split(/\r?\n/)) {
    const match =
      /^(Current session|Current week \([^)]+\)): (\d+(?:\.\d+)?)% used · resets (.+)$/.exec(
        line.trim(),
      );
    if (!match) continue;
    const usedPercent = Number(match[2]);
    const resetsAt = resetAtFromText(match[3]!, input.observedAtMs);
    const complete =
      Number.isFinite(usedPercent) && usedPercent >= 0 && usedPercent <= 100 && resetsAt !== null;
    windows.push({
      id: windowId(match[1]!),
      label: match[1]!,
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
    provider: "claude",
    collectedAt: new Date(input.observedAtMs).toISOString(),
    staleAfter: new Date(input.observedAtMs + 15 * 60_000).toISOString(),
    acquisition: "text_parse",
    // local_sessions_only: Claude's own disclaimer — approximate, this machine only.
    scope: "local_sessions_only",
    collectorVersion: input.collectorVersion,
    // Explicit caveat so consumers never treat this like codex server rateLimits.
    sourceVersion: "claude -p /usage rendered text (approximate; local sessions only)",
    accounts: [
      {
        accountKey: accountKey(localAccountSlot),
        health: windows.some((w) => w.status === "limit_reached") ? "rate_limited" : "ok",
        healthAcquisition: "text_parse",
        healthObservedAt: new Date(input.observedAtMs).toISOString(),
        ...(windows.some((w) => w.status === "parse_unavailable")
          ? { parseErrorCode: "claude_usage_text_incomplete" }
          : {}),
        windows,
      },
    ],
  };
}

export async function readClaudeUsageText(opts?: {
  timeoutMs?: number;
}): Promise<ClaudeUsageReadOutcome> {
  const bin = resolveClaudeBin();
  if (!bin) return { kind: "unsupported" };
  const timeoutMs = opts?.timeoutMs ?? 15_000;

  const auth = await runClaude(bin, ["auth", "status", "--json"], timeoutMs);
  try {
    const parsed = JSON.parse(auth.stdout) as { loggedIn?: unknown };
    if (parsed.loggedIn === false) return { kind: "reauth_required" };
  } catch {
    // Older claude: fall through to /usage
  }

  const usage = await runClaude(
    bin,
    ["-p", "/usage", "--output-format", "json"],
    timeoutMs,
  );
  const output = `${usage.stdout}\n${usage.stderr}`;
  if (usage.error) {
    return /loggedIn\s*[:=]\s*false|auth(?:entication)?\s*(?:missing|required)|log(?:ged)?\s*in/i.test(
      output,
    )
      ? { kind: "reauth_required" }
      : { kind: "error" };
  }
  try {
    const parsed = JSON.parse(usage.stdout) as { result?: unknown };
    return typeof parsed.result === "string" && parsed.result.trim().length > 0
      ? { kind: "ok", text: parsed.result }
      : { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

export async function collectClaudeAccountUsage(opts?: {
  timeoutMs?: number;
  localAccountSlot?: string;
  /** Host adapters inject daemon version; standalone default oar-0.0.0. */
  collectorVersion?: string;
  observedAtMs?: number;
}): Promise<AccountUsageSnapshot> {
  const observedAtMs = opts?.observedAtMs ?? Date.now();
  const collectorVersion = opts?.collectorVersion ?? "oar-0.0.0";
  const localAccountSlot = opts?.localAccountSlot ?? DEFAULT_LOCAL_ACCOUNT_SLOT;
  const outcome = await readClaudeUsageText(opts);
  if (outcome.kind === "ok") {
    return projectClaudeUsageTextSnapshot({
      text: outcome.text,
      collectorVersion,
      observedAtMs,
      localAccountSlot,
    });
  }
  return {
    protocolVersion: ACCOUNT_USAGE_PROTOCOL_VERSION,
    provider: "claude",
    collectedAt: new Date(observedAtMs).toISOString(),
    staleAfter: new Date(observedAtMs + 5 * 60_000).toISOString(),
    acquisition: "text_parse",
    scope: "local_sessions_only",
    collectorVersion,
    accounts: [
      {
        accountKey: accountKey(localAccountSlot),
        health: ((): AccountUsageHealth => {
          if (outcome.kind === "reauth_required") return "reauth_required";
          if (outcome.kind === "unsupported") return "unsupported";
          return "error";
        })(),
        healthAcquisition: "text_parse",
        healthObservedAt: new Date(observedAtMs).toISOString(),
        windows: [],
      },
    ],
  };
}
