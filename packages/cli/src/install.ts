import type { Command } from "commander";
import type { AvailableInstallation, InstallPlan, InstallResult, InstallStep, Runtime } from "@botiverse/oar";

// Pure shape of one `oar install` row, so the action stays a print loop and
// the mapping can be pinned by tests without running any installer.
export interface InstallReport {
  readonly runtimeId: string;
  readonly plan?: InstallPlan;
  readonly install?: InstallResult;
  /** Why the runtime offers no installer at all. */
  readonly unsupported?: string;
  /** The planner or installer threw. */
  readonly error?: string;
}

export interface InstallRequest {
  /** Run the installer; otherwise only plan. */
  readonly install: boolean;
  readonly line?: string;
  readonly timeoutMs?: number;
}

export async function readInstall(runtime: Runtime, request: InstallRequest): Promise<InstallReport> {
  const runtimeId = runtime.id;
  if (runtime.installPlan === undefined || runtime.install === undefined) {
    return { runtimeId, unsupported: `${runtimeId} has no installer oar can run` };
  }
  const options = {
    ...(request.line === undefined ? {} : { line: request.line }),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
  };
  try {
    return request.install
      ? { runtimeId, install: await runtime.install(options) }
      : { runtimeId, plan: await runtime.installPlan(options) };
  } catch (error) {
    return { runtimeId, error: error instanceof Error ? error.message : String(error) };
  }
}

function renderSteps(steps: readonly InstallStep[], source: string): string[] {
  return [...steps.map((step) => `  ${step.display}`), `  (${source})`];
}

function versionOf(installation: AvailableInstallation): string {
  return installation.via === "executable" ? (installation.version ?? "unknown version") : "bundled";
}

function outputTail(output: string): string[] {
  return output.trim().split(/\r?\n/u).filter((line) => line.trim() !== "").slice(-20).map((line) => `  ${line}`);
}

function renderUnsupported(runtimeId: string, answer: Extract<InstallPlan, { kind: "unsupported" }>, lines: readonly string[]): string[] {
  const detail = answer.detail === undefined ? "" : `: ${answer.detail}`;
  const head = `${runtimeId}\tcannot install (${answer.reason})${detail}`;
  if (answer.reason === "line_required" && lines.length > 0) {
    return [head, `  choose one with --line: ${lines.join(", ")}`];
  }
  if (answer.steps === undefined || answer.source === undefined) {
    return [head];
  }
  return [head, "  run it yourself:", ...renderSteps(answer.steps, answer.source)];
}

export function renderInstallReport(report: InstallReport, lines: readonly string[] = []): string[] {
  const { runtimeId } = report;
  if (report.error !== undefined) {
    return [`${runtimeId}\terror: ${report.error}`];
  }
  if (report.unsupported !== undefined) {
    return [`${runtimeId}\t${report.unsupported}`];
  }
  if (report.plan !== undefined) {
    return report.plan.kind === "plan"
      ? [`${runtimeId}\twould run:`, ...renderSteps(report.plan.steps, report.plan.source)]
      : renderUnsupported(runtimeId, report.plan, lines);
  }
  const result = report.install;
  switch (result?.kind) {
    case "installed":
      return [`${runtimeId}\tinstalled ${versionOf(result.installation)}${result.line === undefined ? "" : ` (${result.line})`}`];
    case "already_installed":
      return [`${runtimeId}\talready installed: ${versionOf(result.installation)}`];
    case "failed":
      return [`${runtimeId}\tinstall failed (exit ${String(result.exitCode ?? "none")}); its output:`, ...outputTail(result.output)];
    case "unsupported":
      return renderUnsupported(runtimeId, result, lines);
    case undefined:
      break;
  }
  return [`${runtimeId}\tno result`];
}

/** An installer that ran and left nothing usable, or one that threw, fails the command. */
export function installFailed(report: InstallReport): boolean {
  return report.error !== undefined || report.install?.kind === "failed" || report.install?.kind === "unsupported";
}

/** `oar install <runtime>`: run the runtime's own official installer; --plan only shows it. */
export function registerInstallCommand(program: Command, require: (id: string) => Runtime): void {
  program
    .command("install <runtime>")
    .description("Install a runtime with its vendor's official installer; --plan only shows what would run")
    .option("--plan", "print the steps the installer would run, change nothing")
    .option("--line <line>", "release line, for a runtime that ships several (opencode: v1, v2)")
    .option("--json", "print the report as JSON")
    .option("--timeout <ms>", "installer timeout in milliseconds")
    .action(async (id: string, flags: { plan?: boolean; line?: string; json?: boolean; timeout?: string }) => {
      const timeoutMs = flags.timeout === undefined ? undefined : Number(flags.timeout);
      if (timeoutMs !== undefined && !(Number.isInteger(timeoutMs) && timeoutMs > 0)) {
        process.stderr.write("--timeout must be a positive integer number of milliseconds\n");
        process.exitCode = 1;
        return;
      }
      const runtime = require(id);
      const report = await readInstall(runtime, {
        install: flags.plan !== true,
        ...(flags.line === undefined ? {} : { line: flags.line }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
      if (installFailed(report)) {
        process.exitCode = 1;
      }
      if (flags.json === true) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return;
      }
      const lines = (runtime.installLines ?? []).map((line) => line.line);
      for (const line of renderInstallReport(report, lines)) {
        process.stdout.write(`${line}\n`);
      }
    });
}
