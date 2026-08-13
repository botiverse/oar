/**
 * Dispatch `oar usage` collectors per provider.
 *
 * Host-facing options let Raft (or any daemon) inject:
 * - `collectorVersion` — MUST be the host/daemon version for external adapters
 * - `observedAtMs` — single observation instant for multi-provider sweeps
 * - `localAccountSlot` — account key namespace (slockHome slot)
 *
 * Standalone CLI keeps defaults: collectorVersion=`oar-0.0.0`, slot=`local`,
 * observedAtMs=`Date.now()` per call.
 */
import type { AccountUsageProvider, AccountUsageSnapshot } from "./accountUsage.js";
import { USAGE_PROVIDERS, unsupportedUsageSnapshot } from "./accountUsage.js";
import { collectCodexAccountUsage } from "./host/drivers/codexAccount.js";
import { collectKimiAccountUsage } from "./host/drivers/kimiAccount.js";
import { collectClaudeAccountUsage } from "./host/drivers/claudeAccount.js";

/** Default when the oar CLI collects without a host adapter. */
export const STANDALONE_COLLECTOR_VERSION = "oar-0.0.0" as const;

/**
 * Host-facing collection options. Adapters pass daemonVersion + slot + one clock;
 * they must not import per-provider projectors.
 */
export type CollectUsageOptions = {
  readonly localAccountSlot?: string;
  /**
   * Appears on every AccountUsageSnapshot.collectorVersion.
   * Standalone default: STANDALONE_COLLECTOR_VERSION. Host adapters MUST inject.
   */
  readonly collectorVersion?: string;
  /** Fixed observation instant (ms since epoch). Defaults to Date.now() per call. */
  readonly observedAtMs?: number;
  readonly timeoutMs?: number;
};

function resolveCollectorVersion(opts?: CollectUsageOptions): string {
  return opts?.collectorVersion ?? STANDALONE_COLLECTOR_VERSION;
}

function resolveObservedAtMs(opts?: CollectUsageOptions): number {
  return opts?.observedAtMs ?? Date.now();
}

export async function collectUsage(
  provider: AccountUsageProvider,
  opts?: CollectUsageOptions,
): Promise<AccountUsageSnapshot> {
  const collectorVersion = resolveCollectorVersion(opts);
  const observedAtMs = resolveObservedAtMs(opts);
  const timeoutMs = opts?.timeoutMs;
  const localAccountSlot = opts?.localAccountSlot;
  const forwarded = {
    collectorVersion,
    observedAtMs,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(localAccountSlot !== undefined ? { localAccountSlot } : {}),
  };
  switch (provider) {
    case "codex":
      // app-server account/rateLimits/read (raft RuntimeAccountUsageCodexCollector).
      return collectCodexAccountUsage(forwarded);
    case "kimi":
      // GET {platform.base_url}/usages with host OAuth token (kimi-cli /usage internals).
      return collectKimiAccountUsage(forwarded);
    case "claude":
      // raft-aligned: claude -p /usage --output-format json (text_parse).
      // HaoHao also found GET /api/oauth/usage in the binary — future upgrade path.
      return collectClaudeAccountUsage(forwarded);
    case "grok":
      // HaoHao dive (grok 1.0.0): /usage opens console only; no usage API in binary.
      return unsupportedUsageSnapshot(
        "grok",
        collectorVersion,
        observedAtMs,
        "no_programmable_usage_surface",
        localAccountSlot,
      );
    default: {
      const neverProvider: never = provider;
      throw new Error(`unhandled usage provider: ${String(neverProvider)}`);
    }
  }
}

export function parseUsageProvider(raw: string | undefined): AccountUsageProvider | "all" | null {
  if (!raw || raw === "all") return "all";
  if ((USAGE_PROVIDERS as readonly string[]).includes(raw)) {
    return raw as AccountUsageProvider;
  }
  return null;
}

export async function collectUsageAll(
  opts?: CollectUsageOptions,
): Promise<readonly AccountUsageSnapshot[]> {
  // One observedAt for the whole sweep when host injects; otherwise each call
  // may default independently (standalone path).
  const shared =
    opts?.observedAtMs !== undefined
      ? opts
      : { ...opts, observedAtMs: resolveObservedAtMs(opts) };
  return Promise.all(USAGE_PROVIDERS.map((p) => collectUsage(p, shared)));
}
