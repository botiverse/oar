import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { LastAccount } from "../../contracts/login.js";
import { environmentHome } from "../../shared/environment-home.js";
import { environmentValue } from "../../shared/environment.js";
import { runExecutable } from "../../shared/executable/index.js";
import { asRecord, parseJson } from "../../shared/json.js";

const DBUS_TIMEOUT_MS = 1000;
const OAUTH_METHODS = new Set(["oauth-personal", "oauth-business"]);

/**
 * Read agy's non-credential persisted ACP auth method (`cache/acp-auth-state.json`,
 * `[env]` agy 1.5.13: `{"methodId":"oauth-personal"}`). Returns undefined unless
 * it names a known OAuth method so OAR never probes an unconfigured login path.
 */
export async function readPersistedAcpOAuthMethod(env: Readonly<NodeJS.ProcessEnv>): Promise<string | undefined> {
  const stateFile = path.join(environmentHome(env), ".gemini", "antigravity-cli", "cache", "acp-auth-state.json");
  try {
    const parsed = asRecord(parseJson(await readFile(stateFile, "utf8")));
    const methodId = parsed?.methodId;
    return typeof methodId === "string" && OAUTH_METHODS.has(methodId) ? methodId : undefined;
  } catch {
    return undefined;
  }
}

export interface AntigravityKeyringProbe {
  readonly platform?: NodeJS.Platform;
  readonly secretServiceReachable?: (env: Readonly<NodeJS.ProcessEnv>) => Promise<boolean>;
}

function validEmail(value: unknown): string | undefined {
  if (typeof value !== "string") { return undefined; }
  const trimmed = value.trim();
  return trimmed.includes("@") ? trimmed : undefined;
}

/** Decode ONLY the unverified payload segment of a JWT for display email (no crypto, no network). */
function jwtPayloadEmail(token: unknown): string | undefined {
  if (typeof token !== "string") { return undefined; }
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1] === undefined || parts[1] === "") { return undefined; }
  try {
    const decoded = Buffer.from(parts[1], "base64url").toString("utf8");
    return validEmail(asRecord(parseJson(decoded))?.email);
  } catch {
    return undefined;
  }
}

/**
 * Extract the account email from agy's plain-file OAuth token JSON without
 * ever returning or logging credential values:
 * - `[env]` + `[sym]` agy 1.5.13 (`StoredToken.IDTokenEmail`, `json:"id_token_email,omitempty"`):
 *   agy extracts `email` from the OIDC `id_token` in `RememberIDToken` and stores `id_token_email`.
 * - Fallback: unverified JWT payload `email` if a raw `id_token` string is present.
 */
export function projectAntigravityTokenEmail(payload: unknown): string | undefined {
  const root = asRecord(payload);
  if (root === null) { return undefined; }
  return validEmail(root.id_token_email)
    ?? jwtPayloadEmail(root.id_token)
    ?? jwtPayloadEmail(asRecord(root.token)?.id_token);
}

async function hasLinuxSessionBus(env: Readonly<NodeJS.ProcessEnv>): Promise<boolean> {
  const address = environmentValue(env, "DBUS_SESSION_BUS_ADDRESS");
  if (address !== undefined && address !== "") { return true; }
  const runtimeDir = environmentValue(env, "XDG_RUNTIME_DIR")
    ?? (typeof process.getuid === "function" ? `/run/user/${String(process.getuid())}` : undefined);
  if (runtimeDir === undefined || runtimeDir === "") { return false; }
  try {
    await stat(path.join(runtimeDir, "bus"));
    return true;
  } catch {
    return false;
  }
}

function dbusProbeEnv(env: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const minimal: NodeJS.ProcessEnv = { LC_ALL: "C" };
  for (const key of ["PATH", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"] as const) {
    const value = environmentValue(env, key);
    if (value !== undefined) { minimal[key] = value; }
  }
  return minimal;
}

/**
 * Check whether `org.freedesktop.secrets` is owned or activatable on the Linux
 * D-Bus session bus (pure bus daemon introspection, never touches the keyring).
 * Fails closed (`true`) when a bus exists and introspection cannot prove absence.
 */
async function linuxSecretServiceReachable(env: Readonly<NodeJS.ProcessEnv>): Promise<boolean> {
  if (!(await hasLinuxSessionBus(env))) { return false; }
  const probeEnv = dbusProbeEnv(env);
  const baseArgs = ["--session", "--print-reply=literal", "--dest=org.freedesktop.DBus", "/org/freedesktop/DBus"];
  try {
    const [owner, activatable] = await Promise.all([
      runExecutable("dbus-send", [...baseArgs, "org.freedesktop.DBus.NameHasOwner", "string:org.freedesktop.secrets"], { env: probeEnv, timeoutMs: DBUS_TIMEOUT_MS }),
      runExecutable("dbus-send", [...baseArgs, "org.freedesktop.DBus.ListActivatableNames"], { env: probeEnv, timeoutMs: DBUS_TIMEOUT_MS }),
    ]);
    if (!owner.ok || !activatable.ok) { return true; }
    return owner.stdout.trim() !== "boolean false" || activatable.stdout.includes("org.freedesktop.secrets");
  } catch {
    return true;
  }
}

/**
 * `[sym]` agy 1.5.13 (`compositeTokenStorage.LoadToken` / `LoadStoredToken`):
 * agy reads `KeyringTokenStorage` (`go_keyring`: macOS Keychain, Windows
 * Credential Manager, Linux `org.freedesktop.secrets`) FIRST and falls back to
 * the plain JSON file only when the keyring fails or is empty; `SaveToken`
 * purges the file best-effort after a keyring write. Because a stale plain file
 * could hold an earlier account whenever a keyring backend is reachable, OAR
 * treats the plain file as authoritative ONLY on Linux when Secret Service is
 * proved unreachable (no session bus, or D-Bus confirms `org.freedesktop.secrets`
 * is neither owned nor activatable). On macOS, Windows, and Linux desktops with
 * Secret Service, `email` is omitted so OAR never displays a stale account.
 */
export async function isPlainTokenFileAuthoritative(
  env: Readonly<NodeJS.ProcessEnv>,
  probe: AntigravityKeyringProbe = {},
): Promise<boolean> {
  const platform = probe.platform ?? process.platform;
  if (platform !== "linux") { return false; }
  return !(await (probe.secretServiceReachable ?? linuxSecretServiceReachable)(env));
}

/** Read-only email lookup from agy's plain token file when no OS keyring can shadow it. */
export async function readAntigravityTokenEmail(
  env: Readonly<NodeJS.ProcessEnv>,
  probe: AntigravityKeyringProbe = {},
): Promise<string | undefined> {
  if (!(await isPlainTokenFileAuthoritative(env, probe))) { return undefined; }
  const tokenFile = path.join(environmentHome(env), ".gemini", "antigravity-cli", "antigravity-oauth-token");
  try {
    return projectAntigravityTokenEmail(parseJson(await readFile(tokenFile, "utf8")));
  } catch {
    return undefined;
  }
}

/** Remembered account from a remaining authoritative plain token file when signed out. */
export async function rememberedAntigravityAccount(
  env: Readonly<NodeJS.ProcessEnv>,
  probe: AntigravityKeyringProbe = {},
): Promise<LastAccount | undefined> {
  const email = await readAntigravityTokenEmail(env, probe);
  return email === undefined ? undefined : { email };
}
