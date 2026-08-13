/**
 * Kimi usage via coding API (raft `readKimiUsage` shape) without pulling the SDK:
 * Bearer token from `$KIMI_CODE_HOME|~/.kimi-code/credentials/kimi-code.json`,
 * GET https://api.kimi.com/coding/v1/usages
 *
 * Pure-read; 401/403 → reauth_required.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileExists } from "../probe.js";
import { kimiCodeHome } from "../paths.js";
import type {
  AccountUsageHealth,
  AccountUsageSnapshot,
  AccountUsageWindow,
} from "../../accountUsage.js";
import { ACCOUNT_USAGE_PROTOCOL_VERSION } from "../../accountUsage.js";

const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";

export type KimiUsageReadOutcome =
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
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // kimi /usages returns limit/used/remaining as decimal strings ("52")
  if (typeof value === "string" && value.trim().length > 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
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

function readAccessToken(): string | null {
  const path = join(kimiCodeHome(), "credentials", "kimi-code.json");
  if (!fileExists(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { access_token?: unknown };
    return typeof raw.access_token === "string" && raw.access_token.length > 0
      ? raw.access_token
      : null;
  } catch {
    return null;
  }
}

/** Default slot for oar-standalone callers; daemon swap adapter injects its slockHome. */
const DEFAULT_LOCAL_ACCOUNT_SLOT = "local";

function accountKey(localAccountSlot: string, rawAccount: string): string {
  return createHash("sha256").update(`kimi\0${localAccountSlot}\0${rawAccount}`).digest("hex");
}

function maskedLabel(rawAccount: string): string | undefined {
  const email = /^([^@]+)@([^@]+)$/.exec(rawAccount.trim());
  if (!email) return undefined;
  const prefix = email[1]!.slice(0, 2);
  const domain = email[2]!.slice(0, 60);
  return `${prefix || "*"}***@${domain}`.slice(0, 80);
}

function healthFromAccount(account: RecordValue): AccountUsageHealth {
  if (account.expired === true) return "expired";
  if (account.disabled === true) return "disabled";
  const status = typeof account.status === "string" ? account.status.toLowerCase() : "";
  if (/reauth|unauth|credential/.test(status)) return "reauth_required";
  if (/rate.?limit|quota|exhaust/.test(status)) return "rate_limited";
  if (status === "ok" || status === "active" || status === "allowed" || status === "") return "ok";
  return "error";
}

function windowId(label: string, index: number): string {
  const normalized = label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "_").replaceAll(/^_|_$/g, "");
  return `${(normalized || "usage_limit").slice(0, 48)}_${index}`;
}

function projectWindow(raw: unknown, index: number): AccountUsageWindow | null {
  const value = record(raw);
  if (!value) return null;
  const label = safeLabel(value.label ?? value.name) ?? "Usage limit";
  const explicitPercent = finiteNumber(value.used_percent ?? value.usedPercent);
  const used = finiteNumber(value.used);
  const limit = finiteNumber(value.limit);
  const usedPercent =
    explicitPercent ?? (used !== null && limit !== null && limit > 0 ? (used / limit) * 100 : null);
  const resetRaw = value.reset_at ?? value.resetAt ?? value.resetTime ?? value.reset_time;
  const resetDate =
    typeof resetRaw === "string" || typeof resetRaw === "number" ? new Date(resetRaw) : null;
  const resetsAt =
    resetDate && Number.isFinite(resetDate.getTime()) ? resetDate.toISOString() : null;
  const complete =
    usedPercent !== null && usedPercent >= 0 && usedPercent <= 100 && resetsAt !== null;
  return {
    id: windowId(label, index),
    label,
    status: complete ? (usedPercent >= 100 ? "limit_reached" : "ok") : "parse_unavailable",
    ...(complete ? { usedRatio: Number((usedPercent / 100).toFixed(6)), resetsAt } : {}),
  };
}

export function projectKimiUsageSnapshot(input: {
  outcome: KimiUsageReadOutcome;
  collectorVersion: string;
  observedAtMs: number;
  localAccountSlot?: string;
}): AccountUsageSnapshot {
  const localAccountSlot = input.localAccountSlot ?? DEFAULT_LOCAL_ACCOUNT_SLOT;
  if (input.outcome.kind !== "ok") {
    return {
      protocolVersion: ACCOUNT_USAGE_PROTOCOL_VERSION,
      provider: "kimi",
      collectedAt: new Date(input.observedAtMs).toISOString(),
      staleAfter: new Date(input.observedAtMs + 5 * 60_000).toISOString(),
      acquisition: "structured_endpoint",
      scope: "computer_account",
      collectorVersion: input.collectorVersion,
      accounts: [
        {
          accountKey: accountKey(localAccountSlot, "status"),
          health: ((): AccountUsageHealth => {
            if (input.outcome.kind === "reauth_required") return "reauth_required";
            if (input.outcome.kind === "unsupported") return "unsupported";
            return "error";
          })(),
          windows: [],
        },
      ],
    };
  }

  const result = record(input.outcome.result);
  // Shape A (raft / multi-account): { accounts: [...] }
  // Shape B (kimi-cli /usage API): { usage: {...}, limits: [...] }
  const rawAccounts = Array.isArray(result?.accounts) ? result.accounts : null;

  if (rawAccounts) {
    const accounts = rawAccounts.slice(0, 8).flatMap((rawAccount, accountIndex) => {
      const account = record(rawAccount);
      if (!account) return [];
      const rawIdentity =
        typeof account.account === "string" && account.account.length > 0
          ? account.account
          : `local-slot-${accountIndex}`;
      const windows: AccountUsageWindow[] = [];
      let wIndex = 0;
      const summaryWin = projectWindow(account.summary, wIndex++);
      if (summaryWin) windows.push(summaryWin);
      if (Array.isArray(account.limits)) {
        for (const lim of account.limits) {
          const projected = projectWindow(lim, wIndex++);
          if (projected) windows.push(projected);
        }
      }
      let health = healthFromAccount(account);
      if (health === "ok" && windows.some((w) => w.status === "limit_reached")) {
        health = "rate_limited";
      }
      if (windows.length === 0) {
        health = health === "ok" ? "error" : health;
        windows.push({
          id: "usage_unavailable_0",
          label: "Usage limit",
          status: "parse_unavailable",
        });
      }
      const label = maskedLabel(rawIdentity);
      return [
        {
          accountKey: accountKey(localAccountSlot, rawIdentity),
          ...(label ? { maskedLabel: label } : {}),
          health,
          ...(windows.some((w) => w.status === "parse_unavailable")
            ? { parseErrorCode: "kimi_usage_window_incomplete" }
            : {}),
          windows,
        },
      ];
    });
    if (accounts.length === 0) {
      return projectKimiUsageSnapshot({
        outcome: { kind: "error" },
        collectorVersion: input.collectorVersion,
        observedAtMs: input.observedAtMs,
        localAccountSlot,
      });
    }
    return {
      protocolVersion: ACCOUNT_USAGE_PROTOCOL_VERSION,
      provider: "kimi",
      collectedAt: new Date(input.observedAtMs).toISOString(),
      staleAfter: new Date(input.observedAtMs + 30 * 60_000).toISOString(),
      acquisition: "structured_endpoint",
      scope: "computer_account",
      collectorVersion: input.collectorVersion,
      accounts,
    };
  }

  // Shape B: single-account usage + limits (kimi-cli GET /usages)
  const windows: AccountUsageWindow[] = [];
  let idx = 0;
  const summary = projectWindow(result?.usage, idx++);
  if (summary) windows.push(summary);
  if (Array.isArray(result?.limits)) {
    for (const item of result.limits) {
      const itemRec = record(item);
      if (!itemRec) continue;
      const detail = record(itemRec.detail) ?? itemRec;
      const windowMeta = record(itemRec.window) ?? {};
      const duration = finiteNumber(windowMeta.duration);
      const timeUnit = typeof windowMeta.timeUnit === "string" ? windowMeta.timeUnit : "";
      let label = "Usage limit";
      if (duration !== null && timeUnit.includes("MINUTE")) {
        label =
          duration >= 60 && duration % 60 === 0
            ? `${duration / 60}h limit`
            : `${duration}m limit`;
      } else if (duration !== null && timeUnit.includes("HOUR")) {
        label = `${duration}h limit`;
      } else if (duration !== null && timeUnit.includes("DAY")) {
        label = `${duration}d limit`;
      }
      const projected = projectWindow(
        {
          ...detail,
          name: itemRec.name ?? detail.name ?? detail.title ?? label,
          title: itemRec.title ?? detail.title ?? label,
        },
        idx++,
      );
      if (projected) windows.push(projected);
    }
  }
  let health: AccountUsageHealth = "ok";
  if (windows.some((w) => w.status === "limit_reached")) health = "rate_limited";
  if (windows.length === 0) {
    health = "error";
    windows.push({
      id: "usage_unavailable_0",
      label: "Usage limit",
      status: "parse_unavailable",
    });
  }
  return {
    protocolVersion: ACCOUNT_USAGE_PROTOCOL_VERSION,
    provider: "kimi",
    collectedAt: new Date(input.observedAtMs).toISOString(),
    staleAfter: new Date(input.observedAtMs + 30 * 60_000).toISOString(),
    acquisition: "structured_endpoint",
    scope: "computer_account",
    collectorVersion: input.collectorVersion,
    accounts: [
      {
        accountKey: accountKey(localAccountSlot, "local"),
        health,
        ...(windows.some((w) => w.status === "parse_unavailable")
          ? { parseErrorCode: "kimi_usage_window_incomplete" }
          : {}),
        windows,
      },
    ],
  };
}

export async function readKimiUsage(opts?: {
  timeoutMs?: number;
}): Promise<KimiUsageReadOutcome> {
  const token = readAccessToken();
  if (!token) return { kind: "reauth_required" };
  try {
    const res = await fetch(KIMI_USAGE_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 8_000),
    });
    if (res.status === 401 || res.status === 403) return { kind: "reauth_required" };
    if (res.status === 404 || res.status === 405) return { kind: "unsupported" };
    if (!res.ok) return { kind: "error" };
    return { kind: "ok", result: await res.json() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return /auth|credential|token|log.?in/i.test(message)
      ? { kind: "reauth_required" }
      : { kind: "error" };
  }
}

export async function collectKimiAccountUsage(opts?: {
  timeoutMs?: number;
  localAccountSlot?: string;
  /** Host adapters inject daemon version; standalone default oar-0.0.0. */
  collectorVersion?: string;
  observedAtMs?: number;
}): Promise<AccountUsageSnapshot> {
  const observedAtMs = opts?.observedAtMs ?? Date.now();
  const collectorVersion = opts?.collectorVersion ?? "oar-0.0.0";
  const outcome = await readKimiUsage(opts);
  return projectKimiUsageSnapshot({
    outcome,
    collectorVersion,
    observedAtMs,
    ...(opts?.localAccountSlot !== undefined ? { localAccountSlot: opts.localAccountSlot } : {}),
  });
}
