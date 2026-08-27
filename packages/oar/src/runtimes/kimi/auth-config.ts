import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { runExecutable } from "../../shared/executable/index.js";
import { asRecord, parseJson } from "../../shared/json.js";

const MANAGED_PROVIDER = "managed:kimi-code";
const DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1";
const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
const DEFAULT_OAUTH_KEY = "oauth/kimi-code";

export interface KimiAuthContext {
  readonly baseUrl: string;
  readonly oauthHost: string;
  readonly storage: "file" | "other";
  readonly storageName: string;
  readonly home: string;
  readonly credentialPath: string;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizedEndpoint(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

function oauthKey(oauthHost: string, baseUrl: string): string {
  const normalizedHost = normalizedEndpoint(oauthHost);
  const normalizedBase = normalizedEndpoint(baseUrl);
  if (normalizedHost === DEFAULT_OAUTH_HOST && normalizedBase === DEFAULT_BASE_URL) {
    return DEFAULT_OAUTH_KEY;
  }
  const digest = createHash("sha256")
    .update(JSON.stringify({ oauthHost: normalizedHost, baseUrl: normalizedBase }))
    .digest("hex")
    .slice(0, 16);
  return `oauth/kimi-code-env-${digest}`;
}

function storageName(key: string): string {
  const prefix = "oauth/";
  const candidate = key.startsWith(prefix) ? key.slice(prefix.length) : key;
  if (candidate.length === 0 || candidate.startsWith(".") || basename(candidate) !== candidate) {
    throw new Error("Kimi returned an invalid OAuth credential key");
  }
  return candidate;
}

export function kimiRemainingMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error("Kimi account usage timed out");
  }
  return remaining;
}

/** Resolve Kimi's own managed provider, environment, and credential slot. */
export async function resolveKimiAuth(
  command: string,
  deadline: number,
): Promise<KimiAuthContext | null> {
  // Kimi's public JSON command is the stable way to read its resolved TOML
  // shape without importing private packages or teaching OAR a TOML dialect.
  const result = await runExecutable(command, ["provider", "list", "--json"], {
    env: process.env,
    timeoutMs: kimiRemainingMs(deadline),
  });
  if (!result.ok) {
    return null;
  }
  const root = asRecord(parseJson(result.stdout));
  const provider = asRecord(asRecord(root?.providers)?.[MANAGED_PROVIDER]);
  if (provider === null || provider.type !== "kimi") {
    return null;
  }
  const configuredOAuth = asRecord(provider.oauth);
  const envBaseUrl = text(process.env.KIMI_CODE_BASE_URL);
  const envOAuthHost = text(process.env.KIMI_CODE_OAUTH_HOST ?? process.env.KIMI_OAUTH_HOST);
  const hasEnvironmentOverride = envBaseUrl !== undefined || envOAuthHost !== undefined;
  const baseUrl = normalizedEndpoint(envBaseUrl ?? text(provider.baseUrl) ?? DEFAULT_BASE_URL);
  const oauthHost = normalizedEndpoint(
    envOAuthHost ?? text(configuredOAuth?.oauthHost) ?? DEFAULT_OAUTH_HOST,
  );
  const expectedKey = oauthKey(oauthHost, baseUrl);
  const configuredKey = text(configuredOAuth?.key);
  const selectedKey = !hasEnvironmentOverride && configuredKey === expectedKey
    ? configuredKey
    : expectedKey;
  const configuredStorage = text(configuredOAuth?.storage);
  const selectedStorage = !hasEnvironmentOverride && configuredKey === expectedKey
    && configuredStorage !== undefined && configuredStorage !== "file"
    ? "other"
    : "file";
  const home = text(process.env.KIMI_CODE_HOME) ?? join(homedir(), ".kimi-code");
  const selectedStorageName = storageName(selectedKey);
  return {
    baseUrl,
    oauthHost,
    storage: selectedStorage,
    storageName: selectedStorageName,
    home,
    credentialPath: join(home, "credentials", `${selectedStorageName}.json`),
  };
}
