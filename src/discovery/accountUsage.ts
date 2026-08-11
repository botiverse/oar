/**
 * Host usage / rate-limit snapshot for `oar usage`.
 *
 * Shape follows raft-computer RuntimeAccountUsageSnapshot protocol v1 so
 * Testbed/Raft can share semantics. Local mirror (no @slock-ai/shared dep).
 *
 * Absence: missing measurements are omitted, never invent 0% used.
 * Unsupported runtimes return health=unsupported with empty windows.
 */

import { createHash } from "node:crypto";

export const ACCOUNT_USAGE_PROTOCOL_VERSION = 1 as const;

export type AccountUsageProvider = "claude" | "codex" | "kimi" | "grok";
export type AccountUsageAcquisition =
  | "structured_event"
  | "structured_endpoint"
  | "text_parse";
export type AccountUsageScope =
  | "account_global"
  | "computer_account"
  | "local_sessions_only";
export type AccountUsageHealth =
  | "ok"
  | "expired"
  | "disabled"
  | "rate_limited"
  | "reauth_required"
  | "unsupported"
  | "error";
export type AccountUsageWindowStatus = "ok" | "limit_reached" | "parse_unavailable";

export interface AccountUsageWindow {
  readonly id: string;
  readonly label: string;
  readonly status: AccountUsageWindowStatus;
  readonly usedRatio?: number;
  readonly resetsAt?: string;
  readonly acquisition?: AccountUsageAcquisition;
}

export interface AccountUsageAccount {
  readonly accountKey: string;
  readonly maskedLabel?: string;
  readonly planLabel?: string;
  readonly health: AccountUsageHealth;
  readonly healthAcquisition?: AccountUsageAcquisition;
  readonly healthObservedAt?: string;
  readonly parseErrorCode?: string;
  readonly windows: readonly AccountUsageWindow[];
}

export interface AccountUsageSnapshot {
  readonly protocolVersion: typeof ACCOUNT_USAGE_PROTOCOL_VERSION;
  readonly provider: AccountUsageProvider;
  readonly collectedAt: string;
  readonly staleAfter: string;
  readonly acquisition: AccountUsageAcquisition;
  readonly scope: AccountUsageScope;
  readonly collectorVersion: string;
  readonly sourceVersion?: string;
  readonly accounts: readonly AccountUsageAccount[];
}

/** Providers xxchan asked for; collectors may still return unsupported. */
export const USAGE_PROVIDERS: readonly AccountUsageProvider[] = [
  "claude",
  "codex",
  "kimi",
  "grok",
];

/** Default slot for oar-standalone callers; daemon swap adapter injects its slockHome. */
const DEFAULT_LOCAL_ACCOUNT_SLOT = "local";

/**
 * Per-provider account key. Must satisfy raft's zod schema regex
 * `/^[a-f0-9]{64}$/` (slock `packages/shared/src/runtimeAccountUsage.ts:79`),
 * so the sha256 hex digest is required — the old `${provider}_unsupported`
 * literal violated it. Same shape as the real collectors (e.g. codex
 * `sha256("codex\0"+slot)` — oar `host/drivers/codexAccount.ts:79-80`).
 */
function accountKey(provider: AccountUsageProvider, localAccountSlot: string): string {
  return createHash("sha256").update(`${provider}\0${localAccountSlot}`).digest("hex");
}

export function unsupportedUsageSnapshot(
  provider: AccountUsageProvider,
  collectorVersion: string,
  observedAtMs: number,
  note?: string,
  localAccountSlot: string = DEFAULT_LOCAL_ACCOUNT_SLOT,
): AccountUsageSnapshot {
  return {
    protocolVersion: ACCOUNT_USAGE_PROTOCOL_VERSION,
    provider,
    collectedAt: new Date(observedAtMs).toISOString(),
    staleAfter: new Date(observedAtMs + 5 * 60_000).toISOString(),
    acquisition: "structured_endpoint",
    scope: "account_global",
    collectorVersion,
    ...(note ? { sourceVersion: note } : {}),
    accounts: [
      {
        accountKey: accountKey(provider, localAccountSlot),
        health: "unsupported",
        windows: [],
      },
    ],
  };
}
