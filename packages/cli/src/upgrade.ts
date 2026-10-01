import type { Command } from "commander";
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
  /** The probe, check or updater threw; the other runtimes are still reported. */
  readonly error?: string;
}

export interface UpgradeRequest {
  /** Run the updater; otherwise only check. */
  readonly upgrade: boolean;
  readonly timeoutMs?: number;
}

export async function readUpgrade(runtime: Runtime, request: UpgradeRequest): Promise<UpgradeReport> {
  try {
    const report = await reportUpgrade(runtime, request);
    return report;
  } catch (error) {
    return { runtimeId: runtime.id, error: error instanceof Error ? error.message : String(error) };
  }
}

async function reportUpgrade(runtime: Runtime, request: UpgradeRequest): Promise<UpgradeReport> {
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
  if (report.error !== undefined) {
    return [`${runtimeId}\terror: ${report.error}`];
  }
  if (report.installation !== undefined) {
    return [`${runtimeId}\tnot available (${report.installation.kind})`];
  }
  const lines = [
    ...(report.check === undefined ? [] : [renderCheck(runtimeId, report.check)]),
    ...(report.upgrade === undefined ? [] : renderUpgrade(runtimeId, report.upgrade)),
  ];
  return report.unsupported === undefined ? lines : [...lines, `${runtimeId}\t${report.unsupported}`];
}

/** An upgrade that ran and did not move the version, or a runtime that could not be probed, fails the command. */
export function upgradeFailed(report: UpgradeReport): boolean {
  return report.error !== undefined || report.upgrade?.kind === "failed" || report.upgrade?.kind === "unchanged";
}

/** `oar upgrade [runtime]`: check or run each runtime's own updater. */
export function registerUpgradeCommand(program: Command, selected: (id: string | undefined) => readonly Runtime[]): void {
  program
    .command("upgrade [runtime]")
    .description("Upgrade installed runtimes with their own updaters; --check only reports")
    .option("--check", "report the version each runtime's updater would install, change nothing")
    .option("--json", "print the reports as JSON")
    .option("--timeout <ms>", "per-runtime timeout in milliseconds")
    .action(async (id: string | undefined, flags: { check?: boolean; json?: boolean; timeout?: string }) => {
      const timeoutMs = flags.timeout === undefined ? undefined : Number(flags.timeout);
      if (timeoutMs !== undefined && !(Number.isInteger(timeoutMs) && timeoutMs > 0)) {
        process.stderr.write("--timeout must be a positive integer number of milliseconds\n");
        process.exitCode = 1;
        return;
      }
      const request = { upgrade: flags.check !== true, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
      const reports: UpgradeReport[] = [];
      if (request.upgrade) {
        // One updater at a time: each may download hundreds of megabytes.
        for (const runtime of selected(id)) {
          reports.push(await readUpgrade(runtime, request));
        }
      } else {
        reports.push(...await Promise.all(selected(id).map(async (runtime) => {
          const report = await readUpgrade(runtime, request);
          return report;
        })));
      }
      if (reports.some((report) => upgradeFailed(report))) {
        process.exitCode = 1;
      }
      if (flags.json === true) {
        process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
        return;
      }
      for (const line of reports.flatMap((report) => renderUpgradeReport(report))) {
        process.stdout.write(`${line}\n`);
      }
    });
}
