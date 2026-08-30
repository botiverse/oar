import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type {
  AccountUsageReader,
  AccountUsageSnapshot,
  AccountUsageWindow,
  UtcInstant,
} from "../../contracts/account-usage.js";
import { runExecutable } from "../../shared/executable/index.js";
import { utcInstantFromDate } from "../../shared/instant.js";
import { asNumber, asRecord, parseJson } from "../../shared/json.js";

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
// The structured usage endpoint is gated behind the OAuth beta and requires a
// full `/login` token carrying the `user:profile` scope. Inference-only tokens
// (env CLAUDE_CODE_OAUTH_TOKEN / injected FDs) lack that scope, so this reader
// only consults the persisted login credential.
const OAUTH_BETA = "oauth-2025-04-20";
const PROFILE_SCOPE = "user:profile";

interface StoredOAuth {
  readonly accessToken: string;
  readonly hasProfileScope: boolean;
}

function parseStoredOAuth(raw: string): StoredOAuth | null {
  const oauth = asRecord(asRecord(parseJson(raw))?.claudeAiOauth);
  const accessToken = oauth?.accessToken;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    return null;
  }
  const scopes = oauth?.scopes;
  const hasProfileScope = Array.isArray(scopes) && scopes.includes(PROFILE_SCOPE);
  return { accessToken, hasProfileScope };
}

function credentialsFilePath(): string {
  const base = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(base, ".credentials.json");
}

/**
 * Read Claude Code's persisted `/login` OAuth credential, mirroring the
 * `getClaudeAIOAuthTokens()` fallback: the plaintext credentials file (Linux,
 * and the macOS/Windows fallback), then the macOS Keychain, which stores the
 * same JSON blob. Any failure degrades to `null` — never throws.
 */
async function readStoredOAuth(timeoutMs: number): Promise<StoredOAuth | null> {
  try {
    return parseStoredOAuth(readFileSync(credentialsFilePath(), "utf8"));
  } catch {
    // No file (or unreadable): fall through to the platform keystore.
  }
  if (platform() === "darwin") {
    const keychain = await runExecutable(
      "security",
      ["find-generic-password", "-w", "-s", "Claude Code-credentials"],
      { timeoutMs },
    );
    if (keychain.ok) {
      try {
        return parseStoredOAuth(keychain.stdout);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function usageWindowLabel(kind: unknown, scope: Record<string, unknown> | null): string {
  const modelName = asRecord(scope?.model)?.display_name;
  switch (kind) {
    case "session":
      return "Current session";
    case "weekly_all":
      return "Current week (all models)";
    case "weekly_scoped":
      return typeof modelName === "string" ? `Current week (${modelName})` : "Current week";
    default:
      return typeof kind === "string" && kind.length > 0 ? kind : "Usage limit";
  }
}

async function fetchUsage(accessToken: string, version: string, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(USAGE_ENDPOINT, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-beta": OAUTH_BETA,
        "Content-Type": "application/json",
        "User-Agent": `claude-code/${version}`,
      },
      signal: AbortSignal.timeout(Math.min(timeoutMs, 5000)),
    });
  } catch (error) {
    throw new Error("Failed to reach Claude usage endpoint", { cause: error });
  }
}

function resetInstant(value: unknown): UtcInstant | null {
  if (typeof value !== "string") {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : utcInstantFromDate(date);
}

/**
 * Project the `/api/oauth/usage` payload. The authoritative shape is its
 * `limits` array; a representative (subscription) response is:
 *
 * ```json
 * {
 *   "limits": [
 *     { "kind": "session", "group": "session", "percent": 17, "severity": "normal",
 *       "resets_at": "2026-08-26T13:49:59.725522+00:00", "scope": null, "is_active": false },
 *     { "kind": "weekly_all", "group": "weekly", "percent": 72, "severity": "normal",
 *       "resets_at": "2026-08-28T06:59:59.725547+00:00", "scope": null, "is_active": false },
 *     { "kind": "weekly_scoped", "group": "weekly", "percent": 100, "severity": "critical",
 *       "resets_at": "2026-08-28T06:59:59.725963+00:00",
 *       "scope": { "model": { "display_name": "Fable" } }, "is_active": true }
 *   ]
 * }
 * ```
 */
export function projectClaudeUsage(
  payload: unknown,
  email?: string,
  plan?: string,
): AccountUsageSnapshot {
  const limits = asRecord(payload)?.limits;
  const windows: AccountUsageWindow[] = [];
  let rateLimited = false;
  if (Array.isArray(limits)) {
    for (const entry of limits) {
      const limit = asRecord(entry);
      const percent = asNumber(limit?.percent);
      if (limit === null || percent === null || percent < 0) {
        continue;
      }
      const resetsAt = resetInstant(limit.resets_at);
      windows.push({
        label: usageWindowLabel(limit.kind, asRecord(limit.scope)),
        usedRatio: Number((percent / 100).toFixed(6)),
        ...(resetsAt === null ? {} : { resetsAt }),
      });
      rateLimited ||= limit.severity === "critical" || percent >= 100;
    }
  }
  if (windows.length === 0) {
    throw new Error("Claude usage endpoint returned no usable windows");
  }
  return {
    kind: "available",
    ...(plan === undefined ? {} : { plan }),
    ...(email === undefined ? {} : { email }),
    rateLimited,
    windows,
  };
}

/** Extract Claude Code's explicit subscription tier from a confirmed login. */
export function claudeAccountPlan(payload: unknown): string | undefined {
  const authStatus = asRecord(payload);
  if (authStatus?.loggedIn !== true || typeof authStatus.subscriptionType !== "string") {
    return undefined;
  }
  const plan = authStatus.subscriptionType.trim();
  return plan.length > 0 ? plan : undefined;
}

/**
 * Reads Claude account usage in two steps: `claude auth status --json` for the
 * login gate and account email, then a single read-only request to Anthropic's
 * structured usage endpoint using the persisted `/login` OAuth token. This
 * replaces the older `claude -p /usage` subprocess, which was slower and only
 * returned pre-rendered text.
 */
export const claudeAccountUsage: AccountUsageReader = async (installation, options = {}) => {
  if (installation.via !== "executable") {
    return { kind: "unsupported" };
  }
  const command = installation.command;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const env = { ...process.env, CLAUDECODE: undefined };
  const auth = await runExecutable(command, ["auth", "status", "--json"], { env, timeoutMs });
  if (!auth.ok && auth.exitCode === null) {
    throw new Error("Failed to read Claude authentication status");
  }
  const authStatus = asRecord(parseJson(auth.stdout));
  if (!auth.ok || authStatus?.loggedIn === false) {
    return { kind: "reauth_required" };
  }
  // Only a confirmed login exposes an account email (pinned by the owner's
  // `loggedIn === true` requirement); an absent or non-string email is dropped.
  const email = authStatus?.loggedIn === true && typeof authStatus.email === "string"
    ? authStatus.email
    : undefined;
  const plan = claudeAccountPlan(authStatus);
  if (typeof authStatus?.apiKeySource === "string") {
    // An API key takes precedence over any claude.ai login, and API-key billing
    // has no subscription usage windows.
    return { kind: "unsupported" };
  }

  const stored = await readStoredOAuth(timeoutMs);
  if (stored === null || !stored.hasProfileScope) {
    // No persisted profile-scoped login token means the usage endpoint would
    // reject the request; treat it as needing a fresh `/login`.
    return { kind: "reauth_required" };
  }

  const response = await fetchUsage(stored.accessToken, installation.version ?? "0.0.0", timeoutMs);
  if (response.status === 401 || response.status === 403) {
    return { kind: "reauth_required" };
  }
  if (!response.ok) {
    throw new Error(`Claude usage endpoint returned HTTP ${response.status}`);
  }
  const payload: unknown = parseJson(await response.text());
  return projectClaudeUsage(payload, email, plan);
};
