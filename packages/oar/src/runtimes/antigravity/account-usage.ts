import type { AccountUsageReader, AccountUsageSnapshot, AccountUsageWindow } from "../../contracts/account-usage.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { runExecutable } from "../../shared/executable/index.js";
import { withQueryDeadline } from "../../shared/executable/query.js";
import { remainingMs } from "../../shared/deadline.js";
import { utcInstantFromDate } from "../../shared/instant.js";
import { asNumber, asRecord, asRecordList, parseJson } from "../../shared/json.js";
import { readAntigravityAuthStatus } from "./auth.js";

/*
 * Antigravity's own quota answer: `agy -p "/usage" --output-format json`
 * (agy 1.1.11 and later) answers the read-only slash command without an
 * agent turn, quota or a conversation (its changelog; a signed-in 1.5.7
 * reported `num_turns: 0`, zero tokens and `conversation_id: ""`,
 * 2026-11-12). `command.data.groups[]` are model groups that share limits
 * ("Gemini Models", "Claude and GPT models"), each with `buckets[]`:
 * `id`, `name`, `window` (`weekly`, `5h`), `remaining_fraction`,
 * `reset_time`. Signed out, the same command starts agy's interactive login
 * and waits for it, so the login is checked first with `agy models`, which
 * refuses at once ("Please sign in").
 */
const USAGE = "Antigravity account usage";
const HOUR_MS = 3_600_000;

/** The bucket's window length, by agy's own `window` name; an unknown name has none. */
function windowMs(window: unknown): number | undefined {
  if (window === "5h") { return 5 * HOUR_MS; }
  if (window === "weekly") { return 7 * 24 * HOUR_MS; }
  return undefined;
}

interface UsageReading {
  readonly windows: readonly AccountUsageWindow[];
  /** Every model group has a used-up bucket: no model has quota left. */
  readonly everyGroupExhausted: boolean;
}

/** agy's `/usage` JSON reply: one window per bucket. */
function readUsage(payload: unknown): UsageReading {
  const root = asRecord(payload);
  // agy's status word is not repeated: an unexpected one could carry anything.
  if (root?.status !== "SUCCESS") { throw new Error(`${USAGE}: agy did not answer SUCCESS`); }
  const command = asRecord(root.command);
  if (command?.name !== "usage") { throw new Error(`${USAGE}: agy did not answer the usage command`); }
  const windows: AccountUsageWindow[] = [];
  const groups = asRecordList(asRecord(command.data)?.groups);
  let exhaustedGroups = 0;
  for (const group of groups) {
    const groupName = typeof group.name === "string" && group.name.trim() !== "" ? group.name.trim() : undefined;
    let groupExhausted = false;
    for (const bucket of asRecordList(group.buckets)) {
      const remaining = asNumber(bucket.remaining_fraction);
      if (remaining === null || remaining < 0 || remaining > 1) { continue; }
      const name = typeof bucket.name === "string" && bucket.name.trim() !== "" ? bucket.name.trim() : "Limit";
      const reset = typeof bucket.reset_time === "string" ? utcInstantFromDate(new Date(bucket.reset_time)) : null;
      const durationMs = windowMs(bucket.window);
      groupExhausted ||= remaining <= 0;
      const used = Number((1 - remaining).toFixed(6));
      windows.push({
        label: groupName === undefined ? name : `${groupName} · ${name}`,
        // Rounding never turns a bucket with quota left into a used-up one.
        usedRatio: remaining > 0 ? Math.min(0.999999, used) : 1,
        ...(reset === null ? {} : { resetsAt: reset }),
        ...(typeof bucket.id === "string" && bucket.id !== "" ? { id: bucket.id } : {}),
        ...(durationMs === undefined ? {} : { durationMs }),
        // agy names the group of models that share the limit, not one model or the account.
        ...(groupName === undefined ? {} : { scope: { kind: "models", name: groupName } as const }),
      });
    }
    if (groupExhausted) { exhaustedGroups += 1; }
  }
  if (windows.length === 0) { throw new Error(`${USAGE}: agy reported no usable quota buckets`); }
  return { windows, everyGroupExhausted: groups.length > 0 && exhaustedGroups === groups.length };
}

/** agy's `/credits` JSON reply: the AI credits left, or null when it does not say. */
export function projectAntigravityCredits(payload: unknown): number | null {
  const root = asRecord(payload);
  const command = asRecord(root?.command);
  if (root?.status !== "SUCCESS" || command?.name !== "credits") { return null; }
  return asNumber(asRecord(command.data)?.remaining_credits);
}

/**
 * agy's `/usage` reply as an account usage snapshot. `rateLimited` means no
 * model can run: every model group has a used-up bucket and agy reports no
 * AI credits left (`remainingCredits` 0), which can carry a model past its
 * quota where the account turned them on. Credits not read (undefined, or
 * null when agy did not say) leave it false.
 */
export function projectAntigravityUsage(payload: unknown, remainingCredits?: number | null): AccountUsageSnapshot {
  const reading = readUsage(payload);
  return { kind: "available", rateLimited: reading.everyGroupExhausted && remainingCredits === 0, windows: reading.windows };
}

/** Quota through agy's own `/usage` answer, after its login check; no credential read, no HTTP call of OAR's. */
export const antigravityAccountUsage: AccountUsageReader = async (installation, options = {}) => {
  if (installation.via !== "executable") {
    return { kind: "unsupported", reason: "unsupported_installation" };
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  const snapshot = await withQueryDeadline<AccountUsageSnapshot>(USAGE, timeoutMs, async (signal) => {
    const status = await readAntigravityAuthStatus(installation, { ...(options.env === undefined ? {} : { env: options.env }), timeoutMs: remainingMs(deadline, USAGE), signal });
    if (status.kind === "logged_out") {
      return { kind: "reauth_required", reason: "not_authenticated" };
    }
    // Without a confirmed login, /usage could start agy's interactive login and wait.
    if (status.kind !== "logged_in") {
      throw new Error(`${USAGE}: agy models did not confirm a login`);
    }
    const result = await runExecutable(installation.command, ["-p", "/usage", "--output-format", "json"], {
      env: sessionEnvironment(options.env), timeoutMs: remainingMs(deadline, USAGE), signal,
    });
    const reply = parseJson(result.stdout.trim());
    if (reply === undefined) {
      throw new Error(`${USAGE}: agy -p /usage ${result.ok ? "printed no JSON" : `failed (exit ${String(result.exitCode)})`}`);
    }
    // Credits matter only when no group has quota left; read them then.
    if (!readUsage(reply).everyGroupExhausted) { return projectAntigravityUsage(reply); }
    const credits = await runExecutable(installation.command, ["-p", "/credits", "--output-format", "json"], {
      env: sessionEnvironment(options.env), timeoutMs: remainingMs(deadline, USAGE), signal,
    });
    const creditsReply = parseJson(credits.stdout.trim());
    return projectAntigravityUsage(reply, projectAntigravityCredits(creditsReply));
  });
  return snapshot;
};
