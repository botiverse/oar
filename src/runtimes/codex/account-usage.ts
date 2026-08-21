import { spawn } from "node:child_process";
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
import { resolveExecutable } from "../../shared/executable/index.js";
import { sha256Hex } from "../../shared/hash.js";

function accountKey(localAccountSlot: string): string {
  return sha256Hex(`codex\0${localAccountSlot}`);
}

type ReadOutcome =
  | { readonly kind: "ok"; readonly result: unknown }
  | { readonly kind: "reauth_required" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "error" };

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 80 ? trimmed : undefined;
}

function resetInstant(value: unknown): string | undefined {
  const raw = number(value);
  if (raw === null) return undefined;
  const instant = new Date(raw >= 1_000_000_000_000 ? raw : raw * 1_000);
  return Number.isFinite(instant.getTime()) ? instant.toISOString() : undefined;
}

function windowLabel(value: unknown): string {
  const minutes = number(value);
  if (minutes === null || minutes <= 0) return "Usage limit";
  if (minutes % (7 * 24 * 60) === 0) return `${minutes / (7 * 24 * 60)} weeks`;
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} days`;
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

function statusSnapshot(
  health: Extract<AccountUsageHealth, "reauth_required" | "unsupported" | "error">,
  options: Required<Pick<AccountUsageReadOptions, "collectorVersion" | "localAccountSlot" | "observedAtMs">>,
): AccountUsageSnapshot {
  return {
    protocolVersion: ACCOUNT_USAGE_PROTOCOL_VERSION,
    runtime: "codex",
    collectedAt: new Date(options.observedAtMs).toISOString(),
    staleAfter: new Date(options.observedAtMs + 5 * 60_000).toISOString(),
    acquisition: "structured_endpoint",
    scope: "account_global",
    collectorVersion: options.collectorVersion,
    accounts: [{
      accountKey: accountKey(options.localAccountSlot),
      health,
      windows: [],
    }],
  };
}

export function projectCodexUsage(
  result: unknown,
  options: Required<Pick<AccountUsageReadOptions, "collectorVersion" | "localAccountSlot" | "observedAtMs">>,
): AccountUsageSnapshot {
  const root = record(result);
  const historical = record(root?.rateLimits);
  const indexed = record(root?.rateLimitsByLimitId);
  const buckets = indexed !== null && Object.keys(indexed).length > 0
    ? Object.values(indexed).map(record)
    : [historical];
  const windows: AccountUsageWindow[] = [];
  let health: AccountUsageHealth = "ok";
  let planLabel: string | undefined = undefined;
  let index = 0;
  for (const bucket of buckets) {
    if (bucket === null) continue;
    planLabel ??= text(bucket.planType);
    if (bucket.rateLimitReachedType !== null && bucket.rateLimitReachedType !== undefined) {
      health = "rate_limited";
    }
    for (const kind of ["primary", "secondary"] as const) {
      const candidate = record(bucket[kind]);
      if (candidate === null) continue;
      const usedPercent = number(candidate.usedPercent);
      const resetsAt = resetInstant(candidate.resetsAt);
      const complete = usedPercent !== null && usedPercent >= 0 && usedPercent <= 100
        && resetsAt !== undefined;
      if (complete && usedPercent >= 100) health = "rate_limited";
      windows.push({
        id: `${kind}_${String(index)}`,
        label: windowLabel(candidate.windowDurationMins),
        status: complete ? (usedPercent >= 100 ? "limit_reached" : "ok") : "parse_unavailable",
        ...(complete ? { usedRatio: Number((usedPercent / 100).toFixed(6)), resetsAt } : {}),
      });
      index += 1;
    }
  }
  if (windows.length === 0) {
    health = "error";
    windows.push({ id: "usage_unavailable", label: "Usage limit", status: "parse_unavailable" });
  }
  return {
    protocolVersion: ACCOUNT_USAGE_PROTOCOL_VERSION,
    runtime: "codex",
    collectedAt: new Date(options.observedAtMs).toISOString(),
    staleAfter: new Date(options.observedAtMs + 30 * 60_000).toISOString(),
    acquisition: "structured_endpoint",
    scope: "account_global",
    collectorVersion: options.collectorVersion,
    accounts: [{
      accountKey: accountKey(options.localAccountSlot),
      ...(planLabel === undefined ? {} : { planLabel }),
      health,
      ...(windows.some((window) => window.status === "parse_unavailable")
        ? { parseErrorCode: "codex_rate_limit_window_incomplete" }
        : {}),
      windows,
    }],
  };
}

function readFromAppServer(command: string, timeoutMs: number): Promise<ReadOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, ["app-server", "--listen", "stdio://"], {
      env: process.env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buffer = "";
    let finished = false;
    const finish = (outcome: ReadOutcome): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      // oxlint-disable-next-line promise/no-multiple-resolved -- finished is the settlement guard
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ kind: "error" }), timeoutMs);
    child.once("error", () => finish({ kind: "error" }));
    child.once("exit", () => finish({ kind: "error" }));
    child.stdout.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length === 0) continue;
        let message: RecordValue | null = null;
        try {
          message = record(JSON.parse(line));
        } catch {
          continue;
        }
        if (message?.id === "initialize") {
          child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({ id: "usage", method: "account/rateLimits/read", params: {} })}\n`);
        } else if (message?.id === "usage") {
          const error = record(message.error);
          if (error !== null) {
            const errorText = text(error.message) ?? "";
            if (/authentication required/iu.test(errorText)) finish({ kind: "reauth_required" });
            else if (/method not found|not supported/iu.test(errorText)) finish({ kind: "unsupported" });
            else finish({ kind: "error" });
          } else {
            finish({ kind: "ok", result: message.result });
          }
        }
      }
    });
    child.stdin.write(`${JSON.stringify({
      id: "initialize",
      method: "initialize",
      params: { clientInfo: { name: "oar", version: "0.0.0" }, capabilities: { experimentalApi: true } },
    })}\n`);
  });
}

export function createCodexAccountUsage(): AccountUsage {
  return {
    async read(input = {}): Promise<AccountUsageSnapshot> {
      const options = {
        collectorVersion: input.collectorVersion ?? "oar-0.0.0",
        localAccountSlot: input.localAccountSlot ?? "local",
        observedAtMs: input.observedAtMs ?? Date.now(),
      };
      const command = resolveExecutable("codex");
      if (command === null) {
        return unsupportedAccountUsage({
          runtime: "codex",
          collectorVersion: options.collectorVersion,
          observedAtMs: options.observedAtMs,
          accountKey: accountKey(options.localAccountSlot),
          sourceVersion: "codex executable not found",
        });
      }
      const outcome = await readFromAppServer(command, input.timeoutMs ?? 8_000);
      if (outcome.kind === "ok") return projectCodexUsage(outcome.result, options);
      if (outcome.kind === "reauth_required") return statusSnapshot("reauth_required", options);
      if (outcome.kind === "unsupported") return statusSnapshot("unsupported", options);
      return statusSnapshot("error", options);
    },
  };
}
