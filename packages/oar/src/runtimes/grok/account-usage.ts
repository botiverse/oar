import { withQueryDeadline } from "../../shared/executable/query.js";
import { sessionEnvironment } from "../../shared/environment.js";
/* oxlint-disable typescript/promise-function-async -- Deadline callbacks deliberately return the SDK's native promises. */
import {
  methods,
  RequestError,
} from "@agentclientprotocol/sdk";
import type {
  AccountUsageReader,
  AccountUsageSnapshot,
  UtcInstant,
} from "../../contracts/account-usage.js";
import { withAcpDeadline } from "../../shared/acp/process.js";
import { remainingMs } from "../../shared/deadline.js";
import { utcInstantFromDate } from "../../shared/instant.js";
import { asNumber, asRecord, type JsonRecord } from "../../shared/json.js";
import { selectGrokAuthMethod } from "./session.js";

import { grokAccountEmail, initializeGrokReader, readGrokAccountInfo, signedOutEmail, startGrokReader } from "./account-info.js";

function centValue(value: unknown): number | null {
  return asNumber(asRecord(value)?.val);
}

function resetInstant(value: unknown): UtcInstant | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return utcInstantFromDate(new Date(value)) ?? undefined;
}

function periodLabel(value: unknown): string {
  if (typeof value !== "string") {
    return "Included usage";
  }
  const normalized = value.replace(/^USAGE_PERIOD_TYPE_/u, "").toLowerCase();
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)} included usage`;
}

export function projectGrokUsage(result: unknown, email?: string): AccountUsageSnapshot {
  const root = asRecord(result);
  const config = asRecord(root?.config);
  if (config === null) {
    return { kind: "unsupported", reason: "quota_unavailable" };
  }
  // Match Grok's credit_balance_from_config: an existing billing config
  // without percentage or legacy metrics defaults to zero usage. The native
  // /usage UI uses this for accounts that have not consumed credits yet.
  const missingMetrics = [config.creditUsagePercent, config.used, config.monthlyLimit]
    .every((value) => value === null || value === undefined);
  const explicitPercent = asNumber(config.creditUsagePercent);
  const used = centValue(config.used);
  const limit = centValue(config.monthlyLimit);
  const usedPercent = explicitPercent
    ?? (used !== null && limit !== null && limit > 0 ? (used / limit) * 100 : null)
    ?? (missingMetrics ? 0 : null);
  if (usedPercent === null || usedPercent < 0) {
    throw new Error("Grok returned no usable account usage percentage");
  }
  const period = asRecord(config.currentPeriod);
  const resetsAt = resetInstant(period?.end ?? config.billingPeriodEnd);
  const prepaidBalance = Math.abs(centValue(config.prepaidBalance) ?? 0);
  const onDemandCap = centValue(config.onDemandCap) ?? 0;
  const legacyOnDemandUsed = used !== null && limit !== null ? Math.max(0, used - limit) : 0;
  const onDemandUsed = centValue(config.onDemandUsed) ?? legacyOnDemandUsed;
  const onDemandRatio = onDemandCap > 0
    ? Math.max(0, Math.min(1, onDemandUsed / onDemandCap))
    : null;
  const windows = [{
    label: periodLabel(period?.type),
    usedRatio: Number(Math.min(1, usedPercent / 100).toFixed(6)),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    scope: { kind: "account" } as const,
  }, ...(onDemandRatio === null ? [] : [{
    label: "Pay-as-you-go",
    usedRatio: Number(onDemandRatio.toFixed(6)),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    scope: { kind: "account" } as const,
  }])];
  // The current ACP extension serializes its Rust top-level field as
  // `subscription_tier`; accept the earlier camel-case spelling as a
  // compatibility fallback. Nested billing config fields remain camel-case.
  const rawPlan = root?.subscription_tier ?? root?.subscriptionTier;
  const plan = typeof rawPlan === "string" && rawPlan.trim().length > 0
    ? rawPlan.trim()
    : undefined;
  // Grok's own credit-bar projection treats a positive prepaid balance or an
  // unexhausted on-demand cap as usable headroom after included usage reaches
  // 100%; do not report the account as rate-limited while either remains.
  const rateLimited = usedPercent >= 100
    && prepaidBalance === 0
    && (onDemandRatio === null || onDemandRatio >= 1);
  return {
    kind: "available",
    ...(plan === undefined ? {} : { plan }),
    ...(email === undefined ? {} : { email }),
    rateLimited,
    windows,
  };
}

const USAGE = "Grok account usage";

// Identity is optional. Leave room to return the already-read billing result
// before the caller's deadline, without waiting for process cleanup.
const IDENTITY_MARGIN_MS = 100;

async function readBilling(command: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<AccountUsageSnapshot> {
  const deadline = Date.now() + timeoutMs;
  const runtime = startGrokReader(command, env);
  const stop = (): void => { runtime.kill(); };
  try {
    // Billing or an explicit refusal settles first. Reading optional identity
    // within the remaining budget cannot discard that decision.
    const billing = await withQueryDeadline(USAGE, remainingMs(deadline, USAGE), async (signal) => {
      signal.addEventListener("abort", stop, { once: true });
      let initializedForIdentity = false;
      try {
        const initialized = await initializeGrokReader(runtime, remainingMs(deadline, USAGE));
        signal.throwIfAborted();
        initializedForIdentity = true;
        const method = selectGrokAuthMethod(initialized);
        if (method !== undefined) {
          const authenticate = methods.agent.authenticate;
          await withAcpDeadline(
            runtime,
            authenticate,
            remainingMs(deadline, USAGE),
            (requestOptions) => runtime.connection.agent.request(
              authenticate,
              { methodId: method },
              requestOptions,
            ),
          );
        }
        signal.throwIfAborted();
        const payload = await withAcpDeadline(
          runtime,
          "_x.ai/billing",
          remainingMs(deadline, USAGE),
          (requestOptions) => runtime.connection.agent.request<JsonRecord>(
            "_x.ai/billing",
            {},
            requestOptions,
          ),
        );
        signal.throwIfAborted();
        return payload;
      } catch (error) {
        if (error instanceof RequestError && error.code !== -32_601
          && (error.code === -32_000 || /auth(?:entication)?|log(?:ged)? ?in/iu.test(error.message))) {
          return initializedForIdentity ? "reauth_required" as const : "initialize_refused" as const;
        }
        throw error;
      } finally {
        signal.removeEventListener("abort", stop);
      }
    });
    if (billing === "initialize_refused") { return { kind: "reauth_required", reason: "not_authenticated" }; }
    const identityMs = deadline - Date.now() - IDENTITY_MARGIN_MS;
    const info = identityMs <= 0 ? null : await withQueryDeadline(USAGE, identityMs, async (signal) => {
      signal.addEventListener("abort", stop, { once: true });
      try { return await readGrokAccountInfo(runtime, identityMs); }
      finally { signal.removeEventListener("abort", stop); }
    }, null);
    if (billing === "reauth_required") {
      const email = signedOutEmail(info);
      return { kind: "reauth_required", reason: "not_authenticated", ...(email === undefined ? {} : { lastAccount: { email } }) };
    }
    return projectGrokUsage(billing, grokAccountEmail(info));
  } finally {
    // Process ownership and escalation remain with the ACP process. Joining
    // exited here would discard billing when optional identity times out.
    runtime.kill();
  }
}

export const grokAccountUsage: AccountUsageReader = async (installation, options = {}) => {
  if (installation.via !== "executable") {
    return { kind: "unsupported", reason: "unsupported_installation" };
  }
  try {
    // One grok start and up to four requests, which a slow launcher stretches.
    return await readBilling(installation.command, options.timeoutMs ?? 30_000, sessionEnvironment(options.env));
  } catch (error) {
    if (error instanceof RequestError && error.code === -32_601) {
      return { kind: "unsupported", reason: "endpoint_unavailable" };
    }
    throw new Error("Failed to read Grok account usage", { cause: error });
  }
};
