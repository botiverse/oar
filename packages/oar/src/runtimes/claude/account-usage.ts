import { randomUUID } from "node:crypto";
import type { AccountUsageReader, AccountUsageSnapshot, AccountUsageWindow } from "../../contracts/account-usage.js";
import { runExecutable, spawnLineProcess } from "../../shared/executable/index.js";
import { assertRan } from "../../shared/executable/diagnostics.js";
import { remainingMs } from "../../shared/deadline.js";
import { utcInstantFromDate } from "../../shared/instant.js";
import { asNumber, asRecord, asRecordList, parseJson, type JsonRecord } from "../../shared/json.js";

const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * 24 * HOUR_MS;

/** The native key and, where the key names it, the window's length (claude's own `limits[].group` says session or weekly). */
interface WindowKey {
  readonly id: string;
  readonly durationMs?: number;
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
    usedRatio: Math.min(1, Number((percent / 100).toFixed(6))),
    ...(reset === null ? {} : { resetsAt: reset }),
    ...(key === undefined ? {} : { id: key.id }),
    ...(key?.durationMs === undefined ? {} : { durationMs: key.durationMs }),
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
  add("Current session", limits.five_hour, { id: "five_hour", durationMs: 5 * HOUR_MS });
  add("Current week (all models)", limits.seven_day, { id: "seven_day", durationMs: WEEK_MS });
  add("Current week (OAuth apps)", limits.seven_day_oauth_apps, { id: "seven_day_oauth_apps", durationMs: WEEK_MS });
  if (Array.isArray(limits.model_scoped)) {
    for (const entry of asRecordList(limits.model_scoped)) {
      if (typeof entry.display_name === "string" && entry.display_name.trim().length > 0) {
        // A scoped entry names its model only by display name (2.1.288: `scope.model.id` is null).
        add(`Current week (${entry.display_name})`, entry, { id: `model_scoped:${entry.display_name}`, durationMs: WEEK_MS });
      }
    }
  } else {
    add("Current week (Opus)", limits.seven_day_opus, { id: "seven_day_opus", durationMs: WEEK_MS });
    add("Current week (Sonnet)", limits.seven_day_sonnet, { id: "seven_day_sonnet", durationMs: WEEK_MS });
  }
  const includedExhausted = windows.some((window) => window.usedRatio >= 1);
  const extra = asRecord(limits.extra_usage);
  const extraWindow = extra?.is_enabled === true ? windowOf("Extra usage", extra, { id: "extra_usage" }) : null;
  if (extraWindow !== null) {
    windows.push(extraWindow);
  }
  if (windows.length === 0) {
    throw new Error("Claude get_usage returned no usable windows");
  }
  const plan = typeof root.subscription_type === "string" ? root.subscription_type.trim() : "";
  return {
    kind: "available",
    ...(plan.length === 0 ? {} : { plan }),
    ...(email === undefined ? {} : { email }),
    rateLimited: includedExhausted && !(extraWindow !== null && extraWindow.usedRatio < 1),
    windows,
  };
}

function controlFailure(reply: JsonRecord): AccountUsageSnapshot {
  const detail = typeof reply.error === "string" ? reply.error : "Malformed control response";
  if (/unsupported control request subtype|unknown control request|not supported in this context|not available on this connection/iu.test(detail)) {
    return { kind: "unsupported", reason: "endpoint_unavailable" };
  }
  if (/not logged in|authentication required|please (?:run )?\/login/iu.test(detail)) {
    return { kind: "reauth_required", reason: "not_authenticated" };
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
async function supportsSafeMode(command: string, version: string | undefined, deadline: number): Promise<boolean> {
  const key = `${command}\0${version ?? ""}`;
  const known = safeModeSupport.get(key);
  if (known !== undefined) {
    return known;
  }
  const help = await runExecutable(command, ["--help"], {
    env: { ...process.env, CLAUDECODE: undefined },
    timeoutMs: remainingMs(deadline, USAGE),
  });
  assertRan(help, `Failed to run ${command} --help`);
  if (!help.ok) {
    return false;
  }
  const supported = /(?:^|\s)--safe-mode\b/u.test(help.stdout);
  safeModeSupport.set(key, supported);
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
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  if (!await supportsSafeMode(installation.command, installation.version, deadline)) {
    return { kind: "unsupported", reason: "unsupported_installation" };
  }
  const queryMs = remainingMs(deadline, USAGE);
  const child = spawnLineProcess(installation.command, [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json",
    "--verbose", "--no-session-persistence", "--safe-mode",
  ], { env: { ...process.env, CLAUDECODE: undefined } });
  let pending: { id: string; resolve: (reply: JsonRecord | null) => void } | null = null;
  let ended = false;
  let timedOut = false;
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
  const timer = setTimeout(() => {
    timedOut = true;
    pending?.resolve(null);
    child.kill();
  }, queryMs);
  const query = async (request: JsonRecord): Promise<JsonRecord> => {
    if (ended || timedOut) {
      throw new Error("Claude exited or timed out before answering usage queries");
    }
    const id = `oar-usage-${randomUUID()}`;
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
      return controlFailure(initialized);
    }
    const account = asRecord(asRecord(initialized.response)?.account);
    const email = typeof account?.email === "string" && account.email.trim().length > 0
      ? account.email.trim() : undefined;
    const reply = await query({ subtype: "get_usage", skip_behaviors: true });
    if (reply.subtype !== "success") {
      return controlFailure(reply);
    }
    return projectClaudeUsage(reply.response, email);
  } finally {
    clearTimeout(timer);
    child.kill();
    await child.exited;
  }
};
