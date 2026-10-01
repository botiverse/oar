import type {
  InstallationSnapshot,
  Runtime,
  UpdateCheck,
  UpgradeResult,
} from "@botiverse/oar";

// Pure shape of one `oar upgrade` row, so the action stays a print loop and
// the mapping can be pinned by tests without running any updater.
export interface UpgradeReport {
  readonly runtimeId: string;
  /** Present only when the runtime is installed but not `available`. */
  readonly installation?: InstallationSnapshot;
  readonly check?: UpdateCheck;
  readonly upgrade?: UpgradeResult;
  /** Why the runtime offers no check or no upgrade at all. */
  readonly unsupported?: string;
}

export interface UpgradeRequest {
  /** Run the updater; otherwise only check. */
  readonly upgrade: boolean;
  readonly timeoutMs?: number;
}

export async function readUpgrade(runtime: Runtime, request: UpgradeRequest): Promise<UpgradeReport> {
  const runtimeId = runtime.id;
  if (runtime.installation === undefined) {
    return { runtimeId, unsupported: `${runtimeId} exposes no installation probe` };
  }
  const installation = await runtime.installation();
  if (installation.kind !== "available") {
    return { runtimeId, installation };
  }
  if (runtime.checkUpdate === undefined) {
    return {
      runtimeId,
      unsupported: installation.via === "bundled"
        ? `${runtimeId} is bundled with oar and moves with the oar version`
        : `${runtimeId} exposes no update check`,
    };
  }
  const options = request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs };
  if (!request.upgrade) {
    return { runtimeId, check: await runtime.checkUpdate(installation, options) };
  }
  if (runtime.upgrade === undefined) {
    return { runtimeId, check: await runtime.checkUpdate(installation, options), unsupported: `${runtimeId} has no updater oar can run` };
  }
  return { runtimeId, upgrade: await runtime.upgrade(installation, options) };
}

function renderCheck(runtimeId: string, check: UpdateCheck): string {
  if (check.kind === "unavailable") {
    const detail = check.detail === undefined ? "" : ` (${check.detail})`;
    return `${runtimeId}\tcheck unavailable: ${check.reason}${detail}`;
  }
  const notes = [...(check.channel === undefined ? [] : [`${check.channel} channel`]), check.source];
  let state = `${check.installed} current`;
  if (check.updateAvailable) {
    state = `${check.installed} -> ${check.latest} available`;
  } else if (check.latest !== check.installed) {
    state = `${check.installed}, no update`;
    notes.unshift(`source lists ${check.latest}`);
  }
  return `${runtimeId}\t${state} (${notes.join(", ")})`;
}

function outputTail(output: string): string[] {
  return output.trim().split(/\r?\n/u).filter((line) => line.trim() !== "").slice(-20).map((line) => `  ${line}`);
}

function renderUpgrade(runtimeId: string, upgrade: UpgradeResult): string[] {
  switch (upgrade.kind) {
    case "upgraded":
      return [`${runtimeId}\tupgraded ${upgrade.from} -> ${upgrade.to}`];
    case "current":
      return [renderCheck(runtimeId, upgrade.check)];
    case "unchanged":
      return [`${runtimeId}\tstill ${upgrade.version} after the updater ran; its output:`, ...outputTail(upgrade.output)];
    case "failed":
      return [`${runtimeId}\tupgrade failed (exit ${String(upgrade.exitCode ?? "none")}); its output:`, ...outputTail(upgrade.output)];
    case "unsupported":
      break;
  }
  return [`${runtimeId}\tupgrade unsupported: ${upgrade.reason}${upgrade.detail === undefined ? "" : ` (${upgrade.detail})`}`];
}

export function renderUpgradeReport(report: UpgradeReport): string[] {
  const { runtimeId } = report;
  if (report.installation !== undefined) {
    return [`${runtimeId}\tnot available (${report.installation.kind})`];
  }
  const lines = [
    ...(report.check === undefined ? [] : [renderCheck(runtimeId, report.check)]),
    ...(report.upgrade === undefined ? [] : renderUpgrade(runtimeId, report.upgrade)),
  ];
  return report.unsupported === undefined ? lines : [...lines, `${runtimeId}\t${report.unsupported}`];
}

/** An upgrade that ran and did not move the version is a failed command. */
export function upgradeFailed(report: UpgradeReport): boolean {
  return report.upgrade?.kind === "failed" || report.upgrade?.kind === "unchanged";
}
