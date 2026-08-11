/**
 * Dispatch `oar usage` collectors per provider.
 */
import type { AccountUsageProvider, AccountUsageSnapshot } from "./accountUsage.js";
import { USAGE_PROVIDERS, unsupportedUsageSnapshot } from "./accountUsage.js";
import { collectCodexAccountUsage } from "./host/drivers/codexAccount.js";
import { collectKimiAccountUsage } from "./host/drivers/kimiAccount.js";
import { collectClaudeAccountUsage } from "./host/drivers/claudeAccount.js";

export async function collectUsage(
  provider: AccountUsageProvider,
  opts?: { localAccountSlot?: string },
): Promise<AccountUsageSnapshot> {
  const now = Date.now();
  switch (provider) {
    case "codex":
      // app-server account/rateLimits/read (raft RuntimeAccountUsageCodexCollector).
      return collectCodexAccountUsage(opts);
    case "kimi":
      // GET {platform.base_url}/usages with host OAuth token (kimi-cli /usage internals).
      return collectKimiAccountUsage(opts);
    case "claude":
      // raft-aligned: claude -p /usage --output-format json (text_parse).
      // HaoHao also found GET /api/oauth/usage in the binary — future upgrade path.
      return collectClaudeAccountUsage(opts);
    case "grok":
      // HaoHao dive (grok 1.0.0): /usage opens console only; no usage API in binary.
      return unsupportedUsageSnapshot(
        "grok",
        "oar-0.0.0",
        now,
        "no_programmable_usage_surface",
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
  opts?: { localAccountSlot?: string },
): Promise<readonly AccountUsageSnapshot[]> {
  return Promise.all(USAGE_PROVIDERS.map((p) => collectUsage(p, opts)));
}
