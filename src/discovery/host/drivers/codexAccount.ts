/**
 * Codex account usage via app-server `account/rateLimits/read`.
 *
 * Mirrors raft `runtimeAccountUsageCodexCollector.ts` (initialize → initialized
 * → account/rateLimits/read). Pure-read; does not provision credentials.
 *
 * Sample success result shape (from raft tests / live app-server):
 * ```json
 * {
 *   "rateLimits": {
 *     "primary": { "usedPercent": 25, "resetsAt": 1785819600, "windowDurationMins": 300 },
 *     "secondary": { "usedPercent": 100, "resetsAt": 1786424400, "windowDurationMins": 10080 }
 *   }
 * }
 * ```
 * Also accepts `rateLimitsByLimitId` multi-bucket form.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { which } from "../runtimeProbe.js";
import type {
  AccountUsageHealth,
  AccountUsageSnapshot,
  AccountUsageWindow,
} from "../../accountUsage.js";
import { ACCOUNT_USAGE_PROTOCOL_VERSION } from "../../accountUsage.js";

export type CodexRateLimitsReadOutcome =
  | { kind: "ok"; result: unknown }
  | { kind: "reauth_required" }
  | { kind: "unsupported" }
  | { kind: "error" };

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 80) return undefined;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return undefined;
  }
  return trimmed;
}

function resetInstant(value: unknown): string | null {
  const raw = finiteNumber(value);
  if (raw === null) return null;
  const date = new Date(raw >= 1_000_000_000_000 ? raw : raw * 1_000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function durationLabel(value: unknown): string {
  const minutes = finiteNumber(value);
  if (minutes === null || minutes <= 0) return "Usage limit";
  if (minutes % (7 * 24 * 60) === 0) {
    const weeks = minutes / (7 * 24 * 60);
    return weeks === 1 ? "7 days" : `${weeks} weeks`;
  }
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} days`;
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

/** Default slot for oar-standalone callers; daemon swap adapter injects its slockHome. */
const DEFAULT_LOCAL_ACCOUNT_SLOT = "local";

function accountKey(localAccountSlot: string): string {
  return createHash("sha256").update(`codex\0${localAccountSlot}`).digest("hex");
}

function statusSnapshot(input: {
  health: Extract<AccountUsageHealth, "reauth_required" | "unsupported" | "error">;
  collectorVersion: string;
  observedAtMs: number;
  localAccountSlot: string;
  sourceVersion?: string;
}): AccountUsageSnapshot {
  return {
    protocolVersion: ACCOUNT_USAGE_PROTOCOL_VERSION,
    provider: "codex",
    collectedAt: new Date(input.observedAtMs).toISOString(),
    staleAfter: new Date(input.observedAtMs + 5 * 60_000).toISOString(),
    acquisition: "structured_endpoint",
    scope: "account_global",
    collectorVersion: input.collectorVersion,
    ...(input.sourceVersion ? { sourceVersion: input.sourceVersion } : {}),
    accounts: [
      {
        accountKey: accountKey(input.localAccountSlot),
        health: input.health,
        windows: [],
      },
    ],
  };
}

/** Pure projection — unit-tested without spawning codex. */
export function projectCodexRateLimitsReadSnapshot(input: {
  outcome: CodexRateLimitsReadOutcome;
  collectorVersion: string;
  observedAtMs: number;
  localAccountSlot?: string;
  sourceVersion?: string;
}): AccountUsageSnapshot {
  const localAccountSlot = input.localAccountSlot ?? DEFAULT_LOCAL_ACCOUNT_SLOT;
  if (input.outcome.kind !== "ok") {
    let health: Extract<AccountUsageHealth, "reauth_required" | "unsupported" | "error"> = "error";
    if (input.outcome.kind === "reauth_required") health = "reauth_required";
    else if (input.outcome.kind === "unsupported") health = "unsupported";
    return statusSnapshot({
      health,
      collectorVersion: input.collectorVersion,
      observedAtMs: input.observedAtMs,
      localAccountSlot,
      ...(input.sourceVersion !== undefined ? { sourceVersion: input.sourceVersion } : {}),
    });
  }

  const result = record(input.outcome.result);
  const historical = record(result?.rateLimits);
  const byLimitId = record(result?.rateLimitsByLimitId);
  const buckets =
    byLimitId && Object.keys(byLimitId).length > 0
      ? Object.entries(byLimitId).map(([key, value]) => [key, record(value)] as const)
      : ([[safeLabel(historical?.limitId) ?? "default", historical]] as const);

  const windows: AccountUsageWindow[] = [];
  let health: AccountUsageHealth = "ok";
  let planLabel: string | undefined = undefined;

  for (const [bucketKey, bucket] of buckets) {
    if (!bucket) continue;
    planLabel ??= safeLabel(bucket.planType);
    if (bucket.rateLimitReachedType !== null && bucket.rateLimitReachedType !== undefined) {
      health = "rate_limited";
    }
    for (const kind of ["primary", "secondary"] as const) {
      const window = record(bucket[kind]);
      if (!window) continue;
      const usedPercent = finiteNumber(window.usedPercent);
      const resetsAt = resetInstant(window.resetsAt);
      const complete =
        usedPercent !== null && usedPercent >= 0 && usedPercent <= 100 && resetsAt !== null;
      if (complete && usedPercent >= 100) health = "rate_limited";
      const bucketHash = createHash("sha256").update(bucketKey).digest("hex").slice(0, 12);
      windows.push({
        id: `${kind}_${bucketHash}`,
        label: durationLabel(window.windowDurationMins),
        status: complete ? (usedPercent >= 100 ? "limit_reached" : "ok") : "parse_unavailable",
        ...(complete ? { usedRatio: Number((usedPercent / 100).toFixed(6)), resetsAt } : {}),
      });
    }
  }

  if (windows.length === 0) {
    health = "error";
    windows.push({ id: "primary_unavailable", label: "Usage limit", status: "parse_unavailable" });
  }

  return {
    protocolVersion: ACCOUNT_USAGE_PROTOCOL_VERSION,
    provider: "codex",
    collectedAt: new Date(input.observedAtMs).toISOString(),
    staleAfter: new Date(input.observedAtMs + 30 * 60_000).toISOString(),
    acquisition: "structured_endpoint",
    scope: "account_global",
    collectorVersion: input.collectorVersion,
    ...(input.sourceVersion !== undefined ? { sourceVersion: input.sourceVersion } : {}),
    accounts: [
      {
        accountKey: accountKey(localAccountSlot),
        ...(planLabel !== undefined ? { planLabel } : {}),
        health,
        ...(windows.some((w) => w.status === "parse_unavailable")
          ? { parseErrorCode: "codex_rate_limit_window_incomplete" }
          : {}),
        windows,
      },
    ],
  };
}

export function readCodexRateLimitsFromAppServer(opts: {
  timeoutMs?: number;
  codexBin?: string;
} = {}): Promise<CodexRateLimitsReadOutcome> {
  const bin = opts.codexBin ?? which("codex");
  if (!bin) return Promise.resolve({ kind: "unsupported" });
  const timeoutMs = opts.timeoutMs ?? 8_000;

  return new Promise((resolve) => {
    const proc = spawn(bin, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "ignore"],
      env: process.env,
    });
    let buffer = "";
    let settle: ((outcome: CodexRateLimitsReadOutcome) => void) | null = (outcome) => {
      settle = null;
      clearTimeout(timer);
      proc.stdout?.removeAllListeners("data");
      proc.removeAllListeners("error");
      proc.removeAllListeners("exit");
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
      // oxlint-disable-next-line promise/no-multiple-resolved -- settle nullified first
      resolve(outcome);
    };
    const finish = (outcome: CodexRateLimitsReadOutcome) => {
      settle?.(outcome);
    };
    const timer = setTimeout(() => finish({ kind: "error" }), timeoutMs);

    proc.once("error", () => finish({ kind: "error" }));
    proc.once("exit", () => finish({ kind: "error" }));
    proc.stdout?.on("data", (chunk: Buffer | string) => {
      if (!settle) return;
      buffer += chunk.toString();
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: unknown = null;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (!message || typeof message !== "object") continue;
        const msg = message as {
          id?: unknown;
          result?: unknown;
          error?: { message?: unknown };
          method?: unknown;
        };
        if (msg.method !== undefined && msg.id === undefined) continue;
        if (msg.id === "usage-initialize") {
          if (msg.error !== undefined || msg.result === undefined) {
            finish({ kind: "error" });
            return;
          }
          proc.stdin?.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
          proc.stdin?.write(
            `${JSON.stringify({ id: "usage-read", method: "account/rateLimits/read", params: {} })}\n`,
          );
          continue;
        }
        if (msg.id !== "usage-read") continue;
        if (msg.error) {
          const text = typeof msg.error.message === "string" ? msg.error.message : "";
          let errOutcome: CodexRateLimitsReadOutcome = { kind: "error" };
          if (/chatgpt authentication required/i.test(text)) errOutcome = { kind: "reauth_required" };
          else if (/method not found|not supported/i.test(text)) errOutcome = { kind: "unsupported" };
          finish(errOutcome);
          return;
        }
        finish({ kind: "ok", result: msg.result });
        return;
      }
    });

    proc.stdin?.write(
      `${JSON.stringify({
        id: "usage-initialize",
        method: "initialize",
        params: {
          clientInfo: { name: "oar-account", version: "0.0.0" },
          capabilities: { experimentalApi: true },
        },
      })}\n`,
    );
  });
}

export async function collectCodexAccountUsage(opts?: {
  timeoutMs?: number;
  localAccountSlot?: string;
  /** Host adapters inject daemon version; standalone default oar-0.0.0. */
  collectorVersion?: string;
  observedAtMs?: number;
}): Promise<AccountUsageSnapshot> {
  const observedAtMs = opts?.observedAtMs ?? Date.now();
  const collectorVersion = opts?.collectorVersion ?? "oar-0.0.0";
  const outcome = await readCodexRateLimitsFromAppServer(opts);
  return projectCodexRateLimitsReadSnapshot({
    outcome,
    collectorVersion,
    observedAtMs,
    ...(opts?.localAccountSlot !== undefined ? { localAccountSlot: opts.localAccountSlot } : {}),
  });
}
