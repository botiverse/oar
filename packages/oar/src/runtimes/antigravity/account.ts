import { client, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { LoginAccount } from "../../contracts/login.js";
import { environmentHome } from "../../shared/environment-home.js";
import { environmentValue, sessionEnvironment } from "../../shared/environment.js";
import { antigravityEnvironment } from "./environment.js";
import { withQueryDeadline } from "../../shared/executable/query.js";
import { asRecord, asRecordList } from "../../shared/json.js";
import { startAcpProcess, type AcpProcess } from "../../shared/acp/process.js";
import { antigravityStateArgs } from "./state-directory.js";
import { readAntigravityTokenEmail, readPersistedAcpOAuthMethod } from "./token-email.js";

const PLAN_QUERY = "Antigravity plan query";
const PLAN_TIMEOUT_MS = 5000;
const PLAN_CACHE_TTL_MS = 5 * 60_000;
const META_KEY = "_meta";

const planCache = new Map<string, { readonly plan: string; readonly expiresAt: number }>();

/** Clear cached Antigravity plan tiers (called on login/logout and in tests). */
export function clearAntigravityPlanCache(): void {
  planCache.clear();
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

function silentAuthEnv(env: Readonly<NodeJS.ProcessEnv>, preserveAutoUpdateEnv: boolean): NodeJS.ProcessEnv {
  const existingSsh = environmentValue(env, "SSH_CONNECTION");
  const overlay = {
    SSH_CONNECTION: existingSsh !== undefined && existingSsh !== "" ? existingSsh : "1",
    DISPLAY: null,
    WAYLAND_DISPLAY: null,
  };
  return preserveAutoUpdateEnv ? sessionEnvironment(overlay, env) : antigravityEnvironment(overlay, env);
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
  return silentAuthEnv(env, false);
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
 * Caches positive readings briefly per `(command, home, methodId, email)` so
 * repeated status polls do not spawn `agy acp` every time.
 */
export async function readAntigravityPlan(
  command: string,
  env: Readonly<NodeJS.ProcessEnv>,
  options: { readonly timeoutMs: number; readonly signal?: AbortSignal; readonly email?: string; readonly preserveAutoUpdateEnv?: boolean },
): Promise<string | undefined> {
  const budgetMs = Math.min(options.timeoutMs, PLAN_TIMEOUT_MS);
  if (budgetMs <= 0 || options.signal?.aborted === true) { return undefined; }
  const methodId = await readPersistedAcpOAuthMethod(env);
  if (methodId === undefined) { return undefined; }
  const cacheKey = `${command}\0${environmentHome(env)}\0${methodId}\0${options.email ?? ""}`;
  const cached = planCache.get(cacheKey);
  if (cached !== undefined && cached.expiresAt > Date.now()) { return cached.plan; }
  const resolved = await withQueryDeadline<string | null>(
    PLAN_QUERY,
    budgetMs,
    async (signal, own) => {
      try {
        const runtime = own(startAcpProcess(command, ["acp", ...antigravityStateArgs(env)], client({ name: "oar" }), {
          env: silentAuthEnv(env, options.preserveAutoUpdateEnv === true),
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
  if (resolved !== null) {
    planCache.set(cacheKey, { plan: resolved, expiresAt: Date.now() + PLAN_CACHE_TTL_MS });
  }
  return resolved ?? undefined;
}

/** Combine read-only plain-file email (when authoritative) and silent ACP tier into `LoginAccount`. */
export async function readAntigravityAccount(
  command: string,
  env: Readonly<NodeJS.ProcessEnv>,
  options: { readonly timeoutMs: number; readonly signal?: AbortSignal; readonly preserveAutoUpdateEnv?: boolean },
): Promise<LoginAccount | undefined> {
  const email = await readAntigravityTokenEmail(env);
  const plan = await readAntigravityPlan(command, env, { ...options, ...(email === undefined ? {} : { email }) });
  if (email === undefined && plan === undefined) { return undefined; }
  return {
    ...(email === undefined ? {} : { email }),
    ...(plan === undefined ? {} : { plan }),
  };
}
