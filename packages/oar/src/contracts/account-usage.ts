export const ACCOUNT_USAGE_PROTOCOL_VERSION = 1 as const;

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
  readonly runtime: string;
  readonly collectedAt: string;
  readonly staleAfter: string;
  readonly acquisition: AccountUsageAcquisition;
  readonly scope: AccountUsageScope;
  readonly collectorVersion: string;
  readonly sourceVersion?: string;
  readonly accounts: readonly AccountUsageAccount[];
}

export interface AccountUsageReadOptions {
  readonly collectorVersion?: string;
  readonly localAccountSlot?: string;
  readonly observedAtMs?: number;
  readonly timeoutMs?: number;
}

export interface AccountUsage {
  read(options?: AccountUsageReadOptions): Promise<AccountUsageSnapshot>;
}

export function unsupportedAccountUsage(input: {
  runtime: string;
  collectorVersion: string;
  accountKey: string;
  observedAtMs: number;
  sourceVersion?: string;
}): AccountUsageSnapshot {
  return {
    protocolVersion: ACCOUNT_USAGE_PROTOCOL_VERSION,
    runtime: input.runtime,
    collectedAt: new Date(input.observedAtMs).toISOString(),
    staleAfter: new Date(input.observedAtMs + 5 * 60_000).toISOString(),
    acquisition: "structured_endpoint",
    scope: "account_global",
    collectorVersion: input.collectorVersion,
    ...(input.sourceVersion === undefined ? {} : { sourceVersion: input.sourceVersion }),
    accounts: [
      {
        accountKey: input.accountKey,
        health: "unsupported",
        windows: [],
      },
    ],
  };
}
