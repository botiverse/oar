import type { AccountUsageSnapshot, AccountUsageWindow, InstallationSnapshot, Runtime } from "@botiverse/oar";
import type { RuntimeFailure } from "./each-runtime.js";

// Pure shape of one `oar account usage` row, so the table can be pinned by tests without reading an account.
export interface UsageReport {
  readonly runtimeId: string;
  /** Present when the runtime is not available, so there was nothing to read. */
  readonly installation?: InstallationSnapshot;
  readonly accountUsage?: AccountUsageSnapshot;
}

export async function readUsage(runtime: Runtime): Promise<UsageReport> {
  if (runtime.accountUsage === undefined || runtime.installation === undefined) {
    return { runtimeId: runtime.id, accountUsage: { kind: "unsupported", reason: "capability_unavailable" } };
  }
  const installation = await runtime.installation();
  if (installation.kind !== "available") {
    return { runtimeId: runtime.id, installation };
  }
  return { runtimeId: runtime.id, accountUsage: await runtime.accountUsage(installation) };
}

function percent(ratio: number): string {
  return `${String(Math.round(ratio * 100))}%`;
}

function renderWindow(window: AccountUsageWindow): string {
  // Name the model or group a window is tied to unless its label already does.
  const scope = window.scope === undefined || window.scope.kind === "account" || window.label.includes(window.scope.name) ? "" : ` (${window.scope.name})`;
  const reset = window.resetsAt === undefined ? "" : `, resets ${window.resetsAt}`;
  return `  ${window.label}${scope}: ${percent(window.usedRatio)} used${reset}`;
}

export function renderUsageReport(report: UsageReport | RuntimeFailure): string[] {
  const { runtimeId } = report;
  if ("error" in report) {
    return [`${runtimeId}\terror: ${report.error}`];
  }
  if (report.installation !== undefined) {
    return [`${runtimeId}\tnot available (${report.installation.kind})`];
  }
  const usage = report.accountUsage;
  switch (usage?.kind) {
    case "available": {
      const who = [usage.email ?? usage.displayName, usage.plan].filter((part) => part !== undefined).join(", ");
      const resets = usage.limitResets === undefined ? [] : [`  limit resets available: ${String(usage.limitResets.available)}`];
      return [
        `${runtimeId}\t${who === "" ? "signed in" : who}${usage.rateLimited ? ", rate limited now" : ""}`,
        ...usage.windows.map((window) => renderWindow(window)),
        ...resets,
      ];
    }
    case "reauth_required":
      return [`${runtimeId}\tsign in again${usage.reason === undefined ? "" : ` (${usage.reason})`}`];
    case "unsupported":
      return [`${runtimeId}\tno usage${usage.reason === undefined ? "" : ` (${usage.reason})`}`];
    case undefined:
      break;
  }
  return [`${runtimeId}\tno result`];
}
