import { randomUUID } from "node:crypto";
import type { AccountUsageReader, AccountUsageSnapshot, AccountUsageWindow } from "../../contracts/account-usage.js";
import { spawnLineProcess } from "../../shared/executable/index.js";
import { utcInstantFromDate } from "../../shared/instant.js";
import { asNumber, asRecord, asRecordList, parseJson, type JsonRecord } from "../../shared/json.js";

function windowOf(label: string, value: unknown): AccountUsageWindow | null {
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
  const add = (label: string, value: unknown): void => {
    const window = windowOf(label, value);
    if (window !== null) {
      windows.push(window);
    }
  };
  add("Current session", limits.five_hour);
  add("Current week (all models)", limits.seven_day);
  add("Current week (OAuth apps)", limits.seven_day_oauth_apps);
  if (Array.isArray(limits.model_scoped)) {
    for (const entry of asRecordList(limits.model_scoped)) {
      if (typeof entry.display_name === "string" && entry.display_name.trim().length > 0) {
        add(`Current week (${entry.display_name})`, entry);
      }
    }
  } else {
    add("Current week (Opus)", limits.seven_day_opus);
    add("Current week (Sonnet)", limits.seven_day_sonnet);
  }
  const includedExhausted = windows.some((window) => window.usedRatio >= 1);
  const extra = asRecord(limits.extra_usage);
  const extraWindow = extra?.is_enabled === true ? windowOf("Extra usage", extra) : null;
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
 * Only native control queries; no prompt, credential reads or direct HTTP.
 * Fresh-process session totals are deliberately not exposed as account usage.
 * initialize provides optional account identity; get_usage owns quota access.
 */
export const claudeAccountUsage: AccountUsageReader = async (installation, options = {}) => {
  if (installation.via !== "executable") {
    return { kind: "unsupported", reason: "unsupported_installation" };
  }
  const child = spawnLineProcess(installation.command, [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json",
    "--verbose", "--no-session-persistence",
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
  }, options.timeoutMs ?? 15_000);
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
