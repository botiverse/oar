import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { arch, hostname, release, type as osType } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { asNumber, asRecord, parseJson } from "../../shared/json.js";
import { kimiRemainingMs, type KimiAuthContext } from "./auth-config.js";

const OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const RETRYABLE_REFRESH_STATUSES = new Set([429, 500, 502, 503, 504]);

interface StoredToken {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly expiresIn: number;
  readonly scope: string;
  readonly tokenType: string;
}

export class KimiReauthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KimiReauthError";
  }
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function numeric(value: unknown): number | null {
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }
  const parsed = asNumber(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function parseStoredToken(raw: string): StoredToken | null {
  const value = asRecord(parseJson(raw));
  const accessToken = text(value?.access_token);
  if (accessToken === undefined) {
    return null;
  }
  return {
    accessToken,
    refreshToken: text(value?.refresh_token) ?? "",
    expiresAt: numeric(value?.expires_at) ?? 0,
    expiresIn: numeric(value?.expires_in) ?? 0,
    scope: text(value?.scope) ?? "",
    tokenType: text(value?.token_type) ?? "Bearer",
  };
}

async function readStoredToken(path: string): Promise<StoredToken | null> {
  try {
    return parseStoredToken(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function needsRefresh(token: StoredToken): boolean {
  if (token.expiresAt === 0) {
    return false;
  }
  const threshold = token.expiresIn > 0 ? Math.max(300, token.expiresIn * 0.5) : 300;
  return token.expiresAt - Math.floor(Date.now() / 1000) < threshold;
}

function asciiHeader(value: string, fallback = "unknown"): string {
  const cleaned = value.replaceAll(/[^\u0020-\u007E]/gu, "").trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

async function readDeviceId(home: string): Promise<string | undefined> {
  try {
    return text(await readFile(join(home, "device_id"), "utf8"));
  } catch {
    return undefined;
  }
}

async function refreshHeaders(
  home: string,
  version: string | undefined,
): Promise<Record<string, string>> {
  const deviceId = await readDeviceId(home);
  const runtimeVersion = asciiHeader(version ?? "0.0.0");
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    "Accept": "application/json",
    "User-Agent": `kimi-code-cli/${runtimeVersion}`,
    "X-Msh-Platform": "kimi_code_cli",
    "X-Msh-Version": runtimeVersion,
    "X-Msh-Device-Name": asciiHeader(hostname()),
    "X-Msh-Device-Model": asciiHeader(`${osType()} ${release()} ${arch()}`),
    "X-Msh-Os-Version": asciiHeader(release()),
    ...(deviceId === undefined ? {} : { "X-Msh-Device-Id": asciiHeader(deviceId) }),
  };
}

function refreshedToken(payload: unknown): StoredToken | null {
  const value = asRecord(payload);
  const accessToken = text(value?.access_token);
  const refreshToken = text(value?.refresh_token);
  const expiresIn = numeric(value?.expires_in);
  if (accessToken === undefined || refreshToken === undefined
    || expiresIn === null || expiresIn <= 0) {
    return null;
  }
  return {
    accessToken,
    refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    expiresIn,
    scope: text(value?.scope) ?? "",
    tokenType: text(value?.token_type) ?? "Bearer",
  };
}

async function fetchRefresh(
  url: string,
  headers: Record<string, string>,
  body: string,
  deadline: number,
): Promise<Response | Error> {
  try {
    return await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(kimiRemainingMs(deadline)),
    });
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

async function responsePayload(response: Response): Promise<unknown> {
  try {
    return parseJson(await response.text());
  } catch {
    return {};
  }
}

async function refreshRequest(
  auth: KimiAuthContext,
  token: StoredToken,
  version: string | undefined,
  deadline: number,
): Promise<StoredToken> {
  const url = `${auth.oauthHost}/api/oauth/token`;
  const body = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: token.refreshToken,
  }).toString();
  const headers = await refreshHeaders(auth.home, version);
  let lastFailure: unknown = new Error("Kimi OAuth refresh failed");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await fetchRefresh(url, headers, body, deadline);
    if (result instanceof Error) {
      lastFailure = result;
    } else {
      const payload = await responsePayload(result);
      const errorCode = text(asRecord(payload)?.error);
      if (result.status === 401 || result.status === 403 || errorCode === "invalid_grant") {
        throw new KimiReauthError("Kimi OAuth refresh was rejected");
      }
      if (result.ok) {
        const parsed = refreshedToken(payload);
        if (parsed === null) {
          throw new Error("Kimi OAuth refresh returned an invalid token");
        }
        return parsed;
      }
      lastFailure = new Error(`Kimi OAuth refresh returned HTTP ${result.status}`);
      if (!RETRYABLE_REFRESH_STATUSES.has(result.status)) {
        break;
      }
    }
    if (attempt === 2) {
      break;
    }
    const delayMs = 2 ** attempt * 1000;
    if (kimiRemainingMs(deadline) <= delayMs) {
      break;
    }
    await delay(delayMs);
  }
  throw new Error("Failed to refresh Kimi OAuth token", { cause: lastFailure });
}

async function saveStoredToken(path: string, token: StoredToken): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await chmod(directory, 0o700);
  } catch {
    // Best effort on platforms/filesystems that do not support POSIX modes.
  }
  const temporary = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({
      access_token: token.accessToken,
      refresh_token: token.refreshToken,
      expires_at: token.expiresAt,
      scope: token.scope,
      token_type: token.tokenType,
      expires_in: token.expiresIn,
    }, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      // Ignore cleanup failure and surface the original write error.
    }
    throw error;
  }
}

/** Read and lazily refresh Kimi's runtime-owned OAuth token. */
export async function freshKimiAccessToken(
  auth: KimiAuthContext,
  version: string | undefined,
  deadline: number,
): Promise<string> {
  const initial = await readStoredToken(auth.credentialPath);
  if (initial === null) {
    throw new KimiReauthError("No Kimi OAuth token is stored");
  }
  if (!needsRefresh(initial)) {
    return initial.accessToken;
  }
  if (initial.refreshToken.length === 0) {
    throw new KimiReauthError("Kimi OAuth token cannot be refreshed");
  }

  const lockTarget = join(auth.home, "oauth", auth.storageName);
  await mkdir(dirname(lockTarget), { recursive: true });
  const sentinel = await open(lockTarget, "a", 0o600);
  await sentinel.close();
  const retries = Math.max(0, Math.floor(kimiRemainingMs(deadline) / 250) - 1);
  const releaseLock = await lockfile.lock(lockTarget, {
    realpath: false,
    stale: 5000,
    retries: { retries, factor: 1, minTimeout: 250, maxTimeout: 250 },
  });
  try {
    const afterLock = await readStoredToken(auth.credentialPath);
    if (afterLock === null) {
      throw new KimiReauthError("No Kimi OAuth token is stored");
    }
    if (!needsRefresh(afterLock)) {
      return afterLock.accessToken;
    }
    if (afterLock.refreshToken.length === 0) {
      throw new KimiReauthError("Kimi OAuth token cannot be refreshed");
    }
    const refreshed = await refreshRequest(auth, afterLock, version, deadline);
    await saveStoredToken(auth.credentialPath, refreshed);
    return refreshed.accessToken;
  } finally {
    try {
      await releaseLock();
    } catch {
      // Match Kimi's release-after-stale behavior: a cleanup race must not
      // mask a successfully refreshed token.
    }
  }
}
