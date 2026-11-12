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
const WINDOW_MS: Readonly<Record<string, number>> = { "5h": 5 * HOUR_MS, weekly: 7 * 24 * HOUR_MS };

/** agy's `/usage` JSON reply as an account usage snapshot. */
export function projectAntigravityUsage(payload: unknown): AccountUsageSnapshot {
  const root = asRecord(payload);
  if (root?.status !== "SUCCESS") {
    throw new Error(`${USAGE}: agy answered ${typeof root?.status === "string" ? root.status : "without a status"}`);
  }
  const command = asRecord(root.command);
  if (command?.name !== "usage") {
    throw new Error(`${USAGE}: agy did not answer the usage command`);
  }
  const windows: AccountUsageWindow[] = [];
  for (const group of asRecordList(asRecord(command.data)?.groups)) {
    const groupName = typeof group.name === "string" && group.name.trim() !== "" ? group.name.trim() : undefined;
    for (const bucket of asRecordList(group.buckets)) {
      const remaining = asNumber(bucket.remaining_fraction);
      if (remaining === null || remaining < 0 || remaining > 1) { continue; }
      const name = typeof bucket.name === "string" && bucket.name.trim() !== "" ? bucket.name.trim() : "Limit";
      const reset = typeof bucket.reset_time === "string" ? utcInstantFromDate(new Date(bucket.reset_time)) : null;
      const durationMs = typeof bucket.window === "string" ? WINDOW_MS[bucket.window] : undefined;
      windows.push({
        label: groupName === undefined ? name : `${groupName} · ${name}`,
        usedRatio: Number((1 - remaining).toFixed(6)),
        ...(reset === null ? {} : { resetsAt: reset }),
        ...(typeof bucket.id === "string" && bucket.id !== "" ? { id: bucket.id } : {}),
        ...(durationMs === undefined ? {} : { durationMs }),
        // agy names the group of models that share the limit, not one model or the account.
        ...(groupName === undefined ? {} : { scope: { kind: "models", name: groupName } as const }),
      });
    }
  }
  if (windows.length === 0) {
    throw new Error(`${USAGE}: agy reported no usable quota buckets`);
  }
  return { kind: "available", rateLimited: windows.some((window) => window.usedRatio >= 1), windows };
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
    const result = await runExecutable(installation.command, ["-p", "/usage", "--output-format", "json"], {
      env: sessionEnvironment(options.env), timeoutMs: remainingMs(deadline, USAGE), signal,
    });
    const reply = parseJson(result.stdout.trim());
    if (reply === undefined) {
      throw new Error(`${USAGE}: agy -p /usage ${result.ok ? "printed no JSON" : `failed (exit ${String(result.exitCode)})`}`);
    }
    return projectAntigravityUsage(reply);
  });
  return snapshot;
};
