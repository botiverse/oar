/* oxlint-disable typescript/promise-function-async -- Deadline callbacks deliberately return the SDK's native promises. */
import {
  client as createClient,
  methods,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk";
import type {
  AccountUsageReader,
  AccountUsageSnapshot,
  UtcInstant,
} from "../../contracts/account-usage.js";
import { startAcpProcess, withAcpDeadline } from "../../shared/acp/process.js";
import { utcInstantFromDate } from "../../shared/instant.js";
import { asNumber, asRecord, type JsonRecord } from "../../shared/json.js";
import { grokInitializeMeta, selectGrokAuthMethod } from "./session.js";

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

/** Extract identity only from Grok's authenticated `_x.ai/auth/info` result. */
export function grokAccountEmail(result: unknown): string | undefined {
  const email = asRecord(result)?.email;
  if (typeof email !== "string") {
    return undefined;
  }
  const trimmed = email.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function projectGrokUsage(result: unknown, email?: string): AccountUsageSnapshot {
  const root = asRecord(result);
  const config = asRecord(root?.config);
  if (config === null) {
    return { kind: "unsupported" };
  }
  const explicitPercent = asNumber(config.creditUsagePercent);
  const used = centValue(config.used);
  const limit = centValue(config.monthlyLimit);
  const usedPercent = explicitPercent
    ?? (used !== null && limit !== null && limit > 0 ? (used / limit) * 100 : null);
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
  }, ...(onDemandRatio === null ? [] : [{
    label: "Pay-as-you-go",
    usedRatio: Number(onDemandRatio.toFixed(6)),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  }])];
  const plan = typeof root?.subscriptionTier === "string" && root.subscriptionTier.length > 0
    ? root.subscriptionTier
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

interface GrokAccountPayload {
  readonly billing: JsonRecord;
  readonly email?: string;
}

async function readBilling(command: string, timeoutMs: number): Promise<GrokAccountPayload> {
  const runtime = startAcpProcess(
    command,
    ["agent", "--always-approve", "--no-leader", "stdio"],
    createClient({ name: "oar" }),
    { env: process.env },
  );
  try {
    const initialize = methods.agent.initialize;
    const response = await withAcpDeadline(
      runtime,
      initialize,
      timeoutMs,
      (requestOptions) => runtime.connection.agent.request(initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "oar", version: "0.0.0" },
        _meta: grokInitializeMeta({ cwd: process.cwd() }),
      }, requestOptions),
    );
    const initialized = asRecord(response) ?? {};
    const method = selectGrokAuthMethod(initialized);
    if (method !== undefined) {
      const authenticate = methods.agent.authenticate;
      await withAcpDeadline(
        runtime,
        authenticate,
        timeoutMs,
        (requestOptions) => runtime.connection.agent.request(
          authenticate,
          { methodId: method },
          requestOptions,
        ),
      );
    }
    const billing = await withAcpDeadline(
      runtime,
      "_x.ai/billing",
      timeoutMs,
      (requestOptions) => runtime.connection.agent.request<JsonRecord>(
        "_x.ai/billing",
        {},
        requestOptions,
      ),
    );
    let email: string | undefined = undefined;
    try {
      const authInfo = await withAcpDeadline(
        runtime,
        "_x.ai/auth/info",
        timeoutMs,
        (requestOptions) => runtime.connection.agent.request<JsonRecord>(
          "_x.ai/auth/info",
          {},
          requestOptions,
        ),
      );
      email = grokAccountEmail(authInfo);
    } catch {
      // Older Grok builds and transient identity failures must not hide the
      // billing result that was already read successfully.
      email = undefined;
    }
    return { billing, ...(email === undefined ? {} : { email }) };
  } finally {
    runtime.kill();
    await runtime.exited;
  }
}

export const grokAccountUsage: AccountUsageReader = async (installation, options = {}) => {
  if (installation.via !== "executable") {
    return { kind: "unsupported" };
  }
  try {
    const payload = await readBilling(installation.command, options.timeoutMs ?? 10_000);
    return projectGrokUsage(payload.billing, payload.email);
  } catch (error) {
    if (error instanceof RequestError) {
      if (error.code === -32_601) {
        return { kind: "unsupported" };
      }
      if (error.code === -32_000 || /auth(?:entication)?|log(?:ged)? ?in/iu.test(error.message)) {
        return { kind: "reauth_required" };
      }
    }
    throw new Error("Failed to read Grok account usage", { cause: error });
  }
};
