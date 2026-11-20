import { withQueryDeadline } from "../../shared/executable/query.js";
import type { AccountUsageReader, AccountUsageReadOptions, AccountUsageSnapshot, AccountUsageWindow, AccountUsageWindowScope } from "../../contracts/account-usage.js";
import { runExecutable, spawnLineProcess } from "../../shared/executable/index.js";
import { assertRan } from "../../shared/executable/diagnostics.js";
import { remainingMs } from "../../shared/deadline.js";
import { utcInstantFromDate } from "../../shared/instant.js";
import { asNumber, asRecord, asRecordList, parseJson, type JsonRecord } from "../../shared/json.js";
import { usedRatioFromPercent } from "../../shared/usage-ratio.js";
import { claudePlanDisplayName, rememberedClaudeAccount } from "./last-account.js";
import { claudeEnv } from "./environment.js";

const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * 24 * HOUR_MS;

/** The native key and, where the key names it, the window's length (claude's own `limits[].group` says session or weekly). */
interface WindowKey {
  readonly id: string;
  readonly durationMs?: number;
  readonly scope?: AccountUsageWindowScope;
}

function windowOf(label: string, value: unknown, key?: WindowKey): AccountUsageWindow | null {
  const entry = asRecord(value);
  const percent = asNumber(entry?.utilization);
  if (percent === null || percent < 0) {
    return null;
  }
  const reset = typeof entry?.resets_at === "string" ? utcInstantFromDate(new Date(entry.resets_at)) : null;
  return {
    label,
    usedRatio: usedRatioFromPercent(percent),
    ...(reset === null ? {} : { resetsAt: reset }),
    ...(key === undefined ? {} : { id: key.id }),
    ...(key?.durationMs === undefined ? {} : { durationMs: key.durationMs }),
    ...(key?.scope === undefined ? {} : { scope: key.scope }),
  };
}

/** Native get_usage reply, not the HTTP endpoint's unrelated limits[] shape. */
export function projectClaudeUsage(payload: unknown, email?: string): AccountUsageSnapshot {
  const root = asRecord(payload);
  if (root?.rate_limits_available === false) {
    // The CLI does not distinguish auth mode, missing scope, etc. here.
    return { kind: "unsupported", reason: "quota_unavailable" };
  }
  if (root?.rate_limits_available !== true) {
    throw new Error("Claude get_usage returned an invalid availability flag");
  }
  const limits = asRecord(root.rate_limits);
  if (limits === null) {
    // Available in principle, but the runtime could not supply a snapshot.
    throw new Error("Claude get_usage did not return account rate limits");
  }
  const windows: AccountUsageWindow[] = [];
  const add = (label: string, value: unknown, key: WindowKey): void => {
    const window = windowOf(label, value, key);
    if (window !== null) {
      windows.push(window);
    }
  };
  const account = { kind: "account" } as const;
  add("Current session", limits.five_hour, { id: "five_hour", durationMs: 5 * HOUR_MS, scope: account });
  add("Current week (all models)", limits.seven_day, { id: "seven_day", durationMs: WEEK_MS, scope: account });
  // Third-party OAuth apps' use, not a model's.
  add("Current week (OAuth apps)", limits.seven_day_oauth_apps, { id: "seven_day_oauth_apps", durationMs: WEEK_MS });
  if (Array.isArray(limits.model_scoped)) {
    for (const entry of asRecordList(limits.model_scoped)) {
      const displayName = typeof entry.display_name === "string" ? entry.display_name.trim() : "";
      if (displayName.length > 0) {
        // A scoped entry names its model only by display name (2.1.288: `scope.model.id` is null).
        add(`Current week (${displayName})`, entry, { id: `model_scoped:${displayName}`, durationMs: WEEK_MS, scope: { kind: "model", name: displayName } });
      }
    }
  } else {
    add("Current week (Opus)", limits.seven_day_opus, { id: "seven_day_opus", durationMs: WEEK_MS, scope: { kind: "model", name: "Opus" } });
    add("Current week (Sonnet)", limits.seven_day_sonnet, { id: "seven_day_sonnet", durationMs: WEEK_MS, scope: { kind: "model", name: "Sonnet" } });
  }
  // Top-level rateLimited is account-wide: single-model windows and unknown-scope
  // windows (seven_day_oauth_apps) stay in windows without blocking the whole account.
  const includedExhausted = windows.some((window) => window.scope?.kind === "account" && window.usedRatio >= 1);
  const extra = asRecord(limits.extra_usage);
  const extraWindow = extra?.is_enabled === true ? windowOf("Extra usage", extra, { id: "extra_usage", scope: { kind: "account" } }) : null;
  if (extraWindow !== null) {
    windows.push(extraWindow);
  }
  // Claude 2.1.292's get_usage schema models unlimited Extra Usage as
  // `{ is_enabled: true, monthly_limit: null, utilization: null }` (and renders
  // it as "Unlimited" / "unlimited usage credits", while exhausted credits flip
  // `is_enabled` to false).
  const extraUnlimited = extra?.is_enabled === true
    && extra.monthly_limit === null
    && (extra.utilization === null || extra.utilization === undefined);
  const extraHeadroom = extraUnlimited || (extraWindow !== null && extraWindow.usedRatio < 1);
  if (windows.length === 0) {
    throw new Error("Claude get_usage returned no usable windows");
  }
  const plan = typeof root.subscription_type === "string" ? root.subscription_type.trim() : "";
  return {
    kind: "available",
    ...(plan.length === 0 ? {} : { plan }),
    ...(email === undefined ? {} : { email }),
    rateLimited: includedExhausted && !extraHeadroom,
    windows,
  };
}

async function controlFailure(reply: JsonRecord, env: NodeJS.ProcessEnv, email?: string): Promise<AccountUsageSnapshot> {
  const detail = typeof reply.error === "string" ? reply.error : "Malformed control response";
  if (/unsupported control request subtype|unknown control request|not supported in this context|not available on this connection/iu.test(detail)) {
    return { kind: "unsupported", reason: "endpoint_unavailable" };
  }
  if (/not logged in|authentication required|please (?:run )?\/login/iu.test(detail)) {
    const lastAccount = email === undefined ? await rememberedClaudeAccount(env) : { email };
    return { kind: "reauth_required", reason: "not_authenticated", ...(lastAccount === undefined ? {} : { lastAccount }) };
  }
  throw new Error(`Claude usage control request failed: ${detail}`);
}

/**
 * A usage read must not run the user's hooks or start their MCP servers, so the
 * query process runs with --safe-mode. A CLI that lacks the flag is reported as
 * unsupported rather than launched without isolation. A help probe that timed
 * out or never ran is an operational failure and rejects, like the query's own
 * timeout. Only a successful help probe is cached, so a failed one is retried
 * on the next read.
 */
const USAGE = "Claude account usage";
const safeModeSupport = new Map<string, boolean>();
async function supportsSafeMode(command: string, version: string | undefined, deadline: number, env: AccountUsageReadOptions["env"], signal: AbortSignal): Promise<boolean> {
  const key = `${command}\0${version ?? ""}`;
  const cacheable = Object.keys(env ?? {}).length === 0;
  const known = cacheable ? safeModeSupport.get(key) : undefined;
  if (known !== undefined) {
    return known;
  }
  const help = await runExecutable(command, ["--help"], {
    env: claudeEnv(env), signal,
    timeoutMs: remainingMs(deadline, USAGE),
  });
  signal.throwIfAborted();
  assertRan(help, `Failed to run ${command} --help`);
  if (!help.ok) {
    return false;
  }
  const supported = /(?:^|\s)--safe-mode\b/u.test(help.stdout);
  if (cacheable) { safeModeSupport.set(key, supported); }
  return supported;
}

/**
 * Only native control queries; no prompt, credential reads or direct HTTP.
 * Fresh-process session totals are deliberately not exposed as account usage.
 * initialize provides optional account identity; get_usage owns quota access.
 */
export const claudeAccountUsage: AccountUsageReader = async (installation, options = {}) => {
  if (installation.via !== "executable") {
    return { kind: "unsupported", reason: "unsupported_installation" };
  }
  // One budget for the whole read, shared by the help probe and the query:
  // two claude starts, each of which a slow launcher can stretch.
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  const result = await withQueryDeadline<AccountUsageSnapshot>(USAGE, timeoutMs, async (signal) => {
    if (!await supportsSafeMode(installation.command, installation.version, deadline, options.env, signal)) {
      return { kind: "unsupported", reason: "unsupported_installation" };
    }
    signal.throwIfAborted();
    remainingMs(deadline, USAGE);
    const env = claudeEnv(options.env);
    const child = spawnLineProcess(installation.command, [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json",
      "--verbose", "--no-session-persistence", "--safe-mode",
    ], { env, killTree: true, shutdown: "stdin" });
    let pending: { id: string; resolve: (reply: JsonRecord | null) => void } | null = null;
    let ended = false;
    child.onLine((line) => {
      const message = asRecord(parseJson(line));
      const inner = asRecord(message?.response);
      if (message?.type === "control_response" && pending !== null && inner?.request_id === pending.id) {
        pending.resolve(inner);
      }
    });
    child.onExit(() => {
      ended = true;
      pending?.resolve(null);
    });
    child.stdin.on("error", () => {
      ended = true;
      pending?.resolve(null);
    });
    const stop = (): void => { pending?.resolve(null); child.kill(); };
    signal.addEventListener("abort", stop, { once: true });
    const query = async (request: JsonRecord): Promise<JsonRecord> => {
      if (ended || signal.aborted) {
        throw new Error("Claude exited or timed out before answering usage queries");
      }
      const id = `oar-usage-${globalThis.crypto.randomUUID()}`;
      const { promise, resolve } = Promise.withResolvers<JsonRecord | null>();
      pending = { id, resolve };
      child.write(`${JSON.stringify({ type: "control_request", request_id: id, request })}\n`);
      const reply = await promise;
      pending = null;
      if (reply === null) {
        throw new Error("Claude exited or timed out before answering usage query");
      }
      return reply;
    };
    try {
      await child.spawned;
      const initialized = await query({ subtype: "initialize" });
      if (initialized.subtype !== "success") {
        return await controlFailure(initialized, env);
      }
      const account = asRecord(asRecord(initialized.response)?.account);
      const email = typeof account?.email === "string" && account.email.trim().length > 0
        ? account.email.trim() : undefined;
      const orgName = typeof account?.organization === "string" && account.organization.trim().length > 0
        ? account.organization.trim() : undefined;
      const reply = await query({ subtype: "get_usage", skip_behaviors: true });
      if (reply.subtype !== "success") {
        return await controlFailure(reply, env, email);
      }
      const snapshot = projectClaudeUsage(reply.response, email);
      if (snapshot.kind !== "available") {
        return snapshot;
      }
      const planDisplayName = await claudePlanDisplayName(env, {
        ...(email === undefined ? {} : { email }),
        ...(orgName === undefined ? {} : { orgName }),
      });
      return planDisplayName === undefined ? snapshot : { ...snapshot, plan: planDisplayName };
    } finally {
      signal.removeEventListener("abort", stop);
      child.kill();
      await child.exited;
    }
  });
  return result;
};
