import type {
  AccountUsageReader,
  AccountUsageSnapshot,
  UtcInstant,
} from "../../contracts/account-usage.js";
import { AcpError } from "../../shared/acp/errors.js";
import { startAcpJsonRpcClient } from "../../shared/acp/json-rpc.js";
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

export function projectGrokUsage(result: unknown): AccountUsageSnapshot {
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
    rateLimited,
    windows,
  };
}

async function readBilling(command: string, timeoutMs: number): Promise<JsonRecord> {
  const client = startAcpJsonRpcClient(
    command,
    ["agent", "--always-approve", "--no-leader", "stdio"],
    { env: process.env, requestTimeoutMs: timeoutMs },
  );
  try {
    await client.spawned;
    const initialized = await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "oar", version: "0.0.0" },
      _meta: grokInitializeMeta({ cwd: process.cwd() }),
    });
    const method = selectGrokAuthMethod(initialized);
    if (method !== undefined) {
      await client.request("authenticate", { methodId: method });
    }
    return await client.request("_x.ai/billing", {});
  } finally {
    client.kill();
    await client.exited;
  }
}

export const grokAccountUsage: AccountUsageReader = async (installation, options = {}) => {
  if (installation.via !== "executable") {
    return { kind: "unsupported" };
  }
  try {
    return projectGrokUsage(await readBilling(installation.command, options.timeoutMs ?? 10_000));
  } catch (error) {
    if (error instanceof AcpError && error.kind === "rpc") {
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
