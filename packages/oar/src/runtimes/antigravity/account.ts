import { readFile } from "node:fs/promises";
import path from "node:path";
import { client, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { LastAccount, LoginAccount } from "../../contracts/login.js";
import { environmentHome } from "../../shared/environment-home.js";
import { environmentValue, sessionEnvironment } from "../../shared/environment.js";
import { withQueryDeadline } from "../../shared/executable/query.js";
import { asRecord, asRecordList, parseJson } from "../../shared/json.js";
import { startAcpProcess, type AcpProcess } from "../../shared/acp/process.js";
import { antigravityStateArgs } from "./state-directory.js";

const PLAN_QUERY = "Antigravity plan query";
const PLAN_TIMEOUT_MS = 5000;
const OAUTH_METHODS = new Set(["oauth-personal", "oauth-business"]);
const META_KEY = "_meta";

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

/**
 * Read-only email lookup from agy's plain token file (`<home>/.gemini/antigravity-cli/antigravity-oauth-token`).
 * `[sym]` agy 1.5.13 (`compositeTokenStorage`): uses OS keyring (`go_keyring`: Linux Secret Service,
 * macOS Keychain, Windows Credential Manager) when available and falls back to this plain JSON file
 * when no keyring is available. OAR reads ONLY the plain file so it never triggers an OS keyring prompt
 * and never refreshes or mutates credentials; keyring-only hosts cleanly omit email.
 */
export async function readAntigravityTokenEmail(env: Readonly<NodeJS.ProcessEnv>): Promise<string | undefined> {
  const tokenFile = path.join(environmentHome(env), ".gemini", "antigravity-cli", "antigravity-oauth-token");
  try {
    return projectAntigravityTokenEmail(parseJson(await readFile(tokenFile, "utf8")));
  } catch {
    return undefined;
  }
}

/** Remembered account from a remaining plain token file when signed out (agy logout normally removes the file). */
export async function rememberedAntigravityAccount(env: Readonly<NodeJS.ProcessEnv>): Promise<LastAccount | undefined> {
  const email = await readAntigravityTokenEmail(env);
  return email === undefined ? undefined : { email };
}

/**
 * Extract the non-empty plan/tier name from agy's ACP `authenticate` or
 * `session/new` `_meta.antigravity.tier` envelope (`[env]` agy 1.5.13:
 * `{ _meta: { antigravity: { tier: { name: "Google AI Ultra", id: "g1-ultra-tier", upgradeUri: "" } } } }`).
 */
export function projectAntigravityTier(payload: unknown): string | undefined {
  const meta = asRecord(asRecord(payload)?.[META_KEY]);
  const tier = asRecord(asRecord(meta?.antigravity)?.tier);
  return typeof tier?.name === "string" && tier.name.trim() !== "" ? tier.name.trim() : undefined;
}

/**
 * Read agy's non-credential persisted ACP auth method (`cache/acp-auth-state.json`,
 * `[env]` agy 1.5.13: `{"methodId":"oauth-personal"}`). Returns undefined unless
 * it names a known OAuth method so OAR never probes an unconfigured login path.
 */
async function readPersistedAcpOAuthMethod(env: Readonly<NodeJS.ProcessEnv>): Promise<string | undefined> {
  const stateFile = path.join(environmentHome(env), ".gemini", "antigravity-cli", "cache", "acp-auth-state.json");
  try {
    const parsed = asRecord(parseJson(await readFile(stateFile, "utf8")));
    const methodId = parsed?.methodId;
    return typeof methodId === "string" && OAUTH_METHODS.has(methodId) ? methodId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Defense-in-depth child environment for agy's silent ACP tier read:
 * `[sym]` + `[env]` agy 1.5.13 `google3/third_party/jetski/cli/acp/auth/auth.browserUnavailableReason`
 * checks `SSH_CONNECTION`, `SSH_CLIENT`, and `SSH_TTY` (then `DISPLAY` and
 * `WAYLAND_DISPLAY` on Linux) before opening a browser, returning JSON-RPC
 * `-32603` immediately if silent auth cannot satisfy the requested method.
 * This is a backstop only; callers must confirm sign-in with `agy models`,
 * match the persisted method from `cache/acp-auth-state.json`, and enforce a
 * short deadline that kills the child process.
 */
export function antigravitySilentAuthEnv(env: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const existingSsh = environmentValue(env, "SSH_CONNECTION");
  return sessionEnvironment(
    {
      SSH_CONNECTION: existingSsh !== undefined && existingSsh !== "" ? existingSsh : "1",
      DISPLAY: null,
      WAYLAND_DISPLAY: null,
    },
    env,
  );
}

async function requestTier(process: AcpProcess, methodId: string, signal: AbortSignal): Promise<string | undefined> {
  await process.spawned;
  signal.throwIfAborted();
  const initialized = await process.connection.agent.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "oar", version: "0.0.0" },
  });
  signal.throwIfAborted();
  const root = asRecord(initialized);
  const antigravityCaps = asRecord(asRecord(asRecord(root?.agentCapabilities)?.[META_KEY])?.antigravity);
  if (antigravityCaps?.tier !== true) {
    return undefined;
  }
  if (!asRecordList(root?.authMethods).some((entry) => entry.id === methodId)) {
    return undefined;
  }
  // `[sym]` + `[env]` agy 1.5.13: `authenticate` calls `trySilentConsumer` -> `fetchTier`
  // (`GetUserTier` + `GetLoadCodeAssistResponse`, no `SaveUserTier`, no model session, no quota);
  // live strace/stat confirmed `antigravity-oauth-token` is opened read-only after `agy models`.
  const reply = await process.connection.agent.request("authenticate", { methodId });
  return projectAntigravityTier(reply);
}

/**
 * Best-effort read of Antigravity's subscription tier name via ACP `authenticate`
 * on a fresh `agy acp` process (no `--process-per-session`, no `session/new`).
 * Returns undefined on any mismatch, failure or timeout so callers omit `plan`
 * without guessing or failing status/usage reads.
 */
export async function readAntigravityPlan(
  command: string,
  env: Readonly<NodeJS.ProcessEnv>,
  options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
): Promise<string | undefined> {
  const budgetMs = Math.min(options.timeoutMs, PLAN_TIMEOUT_MS);
  if (budgetMs <= 0 || options.signal?.aborted === true) {
    return undefined;
  }
  const methodId = await readPersistedAcpOAuthMethod(env);
  if (methodId === undefined) {
    return undefined;
  }
  const resolved = await withQueryDeadline<string | null>(
    PLAN_QUERY,
    budgetMs,
    async (signal, own) => {
      try {
        const runtime = own(startAcpProcess(command, ["acp", ...antigravityStateArgs(env)], client({ name: "oar" }), {
          env: antigravitySilentAuthEnv(env),
          inheritStderr: false,
          redact: () => "Antigravity tier query failed",
        }));
        return (await requestTier(runtime, methodId, signal)) ?? null;
      } catch {
        return null;
      }
    },
    null,
    options.signal,
  );
  return resolved ?? undefined;
}

/** Combine read-only plain-file email and silent ACP tier into `LoginAccount` (omitted when both absent). */
export async function readAntigravityAccount(
  command: string,
  env: Readonly<NodeJS.ProcessEnv>,
  options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
): Promise<LoginAccount | undefined> {
  const [email, plan] = await Promise.all([
    readAntigravityTokenEmail(env),
    readAntigravityPlan(command, env, options),
  ]);
  if (email === undefined && plan === undefined) {
    return undefined;
  }
  return {
    ...(email === undefined ? {} : { email }),
    ...(plan === undefined ? {} : { plan }),
  };
}
