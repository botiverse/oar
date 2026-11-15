import type { AccountUsageReader, AccountUsageSnapshot, AccountUsageWindow, AccountUsageWindowScope } from "../../contracts/account-usage.js";
import { remainingMs } from "../../shared/deadline.js";
import { credentialHeaderValue, requestFailure } from "../../shared/credential-http.js";
import { environmentValue } from "../../shared/environment.js";
import { utcInstantFromDate } from "../../shared/instant.js";
import { asNumber, asRecord, parseJson } from "../../shared/json.js";
import { factoryCredential } from "./account-credential.js";
import { accountUsageEnvironment } from "../../shared/usage-environment.js";

/*
 * Factory droid's own usage screen (droid 1.12.1, read from its bundle; no
 * Factory account has answered it yet): `GET <api>/api/billing/limits` with
 * `Authorization: Bearer <credential>` and, for a signed-in user,
 * `X-Factory-Org-Id`. `<api>` is `FACTORY_API_BASE_URL` (default
 * https://api.factory.ai), or `FACTORY_API_BASE_URL_EU` (default
 * https://api.eu.factory.ai) for an account droid has routed to region `eu`.
 * The answer is not schema-checked by droid itself; its screen reads
 * `limits.standard` and `limits.core`, each `{ fiveHour, weekly, monthly }`
 * buckets of `{ usedPercent, windowEnd, unlimited? }`, plus
 * `hasActiveSubscription`, `extraUsageBalanceCents`, `overagePreference` and
 * `extraUsageAllowed`. A bucket whose `windowEnd` is absent or past has reset
 * (droid shows 0%). droid has no limit-reset endpoint.
 *
 * The credential is the one droid itself would use, read as stored and never
 * refreshed or written: `FACTORY_API_KEY` when set, else droid's
 * `~/.factory/auth.v2.file`, AES-256-GCM encrypted with `~/.factory/auth.v2.key`
 * (droid's "keyfile" storage). A login droid keeps under an OS keyring key
 * (`auth.v2.keyring`, `auth.v2.loginkeychain`) is not readable here.
 */
const NAME = "Factory account usage";
const API = "https://api.factory.ai";
const API_EU = "https://api.eu.factory.ai";
const LIMITS = "/api/billing/limits";
const TIERS = [
  { key: "fiveHour", label: "5-hour", durationMs: 5 * 3_600_000 },
  { key: "weekly", label: "Weekly", durationMs: 7 * 86_400_000 },
  // droid names the bucket "monthly" and gives its end; it does not say how long it is.
  { key: "monthly", label: "Monthly", durationMs: undefined },
] as const;

function baseUrl(value: string | undefined, fallback: string): string {
  const url = value === undefined || value.trim() === "" ? fallback : value.trim().replace(/\/+$/u, "");
  if (!/^https?:\/\//u.test(url)) { throw new Error(`${NAME}: the Factory API base URL must start with http:// or https://`); }
  return url;
}

function bucketWindow(value: unknown, tier: (typeof TIERS)[number], prefix: string, labelPrefix: string, scope: AccountUsageWindowScope, now: number): AccountUsageWindow | "unlimited" | null {
  const bucket = asRecord(value);
  if (bucket === null) { return null; }
  if (bucket.unlimited === true) { return "unlimited"; }
  const used = asNumber(bucket.usedPercent);
  if (used === null || used < 0) { return null; }
  let resetsAt = null;
  if (typeof bucket.windowEnd === "string") {
    resetsAt = utcInstantFromDate(new Date(bucket.windowEnd));
    if (resetsAt === null) { return null; }
  } else if (bucket.windowEnd !== null && bucket.windowEnd !== undefined) { return null; }
  // Without a future end the window has reset: droid shows it at 0%.
  const running = resetsAt !== null && Date.parse(resetsAt) > now;
  return {
    id: `${prefix}.${tier.key}`, label: `${labelPrefix}${tier.label}`,
    usedRatio: running ? Number(Math.min(1, used / 100).toFixed(6)) : 0,
    ...(running && resetsAt !== null ? { resetsAt } : {}),
    ...(tier.durationMs === undefined ? {} : { durationMs: tier.durationMs }),
    scope,
  };
}

/** Project `/api/billing/limits` as droid's usage screen reads it. */
export function projectFactoryUsage(payload: unknown, now: number = Date.now()): AccountUsageSnapshot {
  const root = asRecord(payload);
  if (root === null) { throw new Error("Factory limits response is not an object"); }
  const limits = asRecord(root.limits);
  const groups = [
    { group: asRecord(limits?.standard), prefix: "standard", labelPrefix: "", scope: { kind: "account" } as const },
    { group: asRecord(limits?.core), prefix: "core", labelPrefix: "Droid Core ", scope: { kind: "models", name: "Droid Core" } as const },
  ].filter(entry => entry.group !== null);
  if (groups.length === 0) {
    if (root.hasActiveSubscription === false) { return { kind: "unsupported", reason: "quota_unavailable" }; }
    throw new Error("Factory limits response has no limits");
  }
  const read = groups.flatMap(({ group, prefix, labelPrefix, scope }) => TIERS.map((tier) => {
    const window = bucketWindow(group?.[tier.key], tier, prefix, labelPrefix, scope, now);
    return { prefix, window };
  }));
  const windows = read.flatMap(entry => entry.window !== null && entry.window !== "unlimited" ? [entry.window] : []);
  if (windows.length === 0 && !read.some(entry => entry.window === "unlimited")) { throw new Error("Factory limits response contains no usable windows"); }
  // Standard Usage spent: droid continues only on Extra Usage the account allows and has balance for.
  const exhausted = windows.some(window => window.id?.startsWith("standard.") === true && window.usedRatio >= 1);
  const extraUsage = root.overagePreference === "extraUsage" && root.extraUsageAllowed === true && (asNumber(root.extraUsageBalanceCents) ?? 0) > 0;
  return { kind: "available", rateLimited: exhausted && !extraUsage, windows };
}

async function body(response: Response): Promise<unknown> {
  let text = "";
  try { text = await response.text(); }
  catch { throw new Error("Factory limits response body could not be read"); }
  const parsed = parseJson(text);
  if (parsed === undefined) { throw new Error("Factory limits response is not valid JSON"); }
  return parsed;
}

export const factoryAccountUsage: AccountUsageReader = async (installation, options = {}) => {
  if (installation.via !== "executable") { return { kind: "unsupported", reason: "unsupported_installation" }; }
  const env = accountUsageEnvironment("Factory", options.env);
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  const api = baseUrl(environmentValue(env, "FACTORY_API_BASE_URL"), API);
  try {
    const credential = await factoryCredential(env, api);
    if (credential.kind === "snapshot") { return credential.snapshot; }
    credentialHeaderValue(credential.token, "The Factory credential");
    if (credential.organizationId !== null) { credentialHeaderValue(credential.organizationId, "droid's stored organization id"); }
    const base = credential.region === "eu" ? baseUrl(environmentValue(env, "FACTORY_API_BASE_URL_EU"), API_EU) : api;
    let response: Response | null = null;
    try {
      response = await fetch(`${base}${LIMITS}`, {
        headers: {
          "Authorization": `Bearer ${credential.token}`, "Accept": "application/json", "X-Factory-Client": "cli",
          ...(installation.version === undefined ? {} : { "X-Client-Version": installation.version }),
          ...(credential.organizationId === null ? {} : { "X-Factory-Org-Id": credential.organizationId }),
        },
        signal: AbortSignal.timeout(remainingMs(deadline, NAME)),
      });
    } catch (error) {
      // Not the cause: fetch's errors can quote the Authorization header.
      throw requestFailure("Failed to reach the Factory limits endpoint", error);
    }
    if (response.status === 401 || response.status === 403) { return { kind: "reauth_required", reason: "credentials_rejected" }; }
    if (response.status === 404) { return { kind: "unsupported", reason: "endpoint_unavailable" }; }
    if (!response.ok) { throw new Error(`Factory limits endpoint returned HTTP ${String(response.status)}`); }
    return projectFactoryUsage(await body(response));
  } catch (error) {
    throw new Error("Failed to read Factory account usage", { cause: error });
  }
};
