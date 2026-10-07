import type { Command } from "commander";
import type { InstallationSnapshot, LogoutResult, Runtime } from "@botiverse/oar";

// Pure shapes of `oar logout` output, as for `oar login`, so the mapping can
// be pinned by tests without running any logout.
export interface LogoutReport {
  readonly runtimeId: string;
  /** Present only when the runtime is installed but not `available`. */
  readonly installation?: InstallationSnapshot;
  readonly result?: LogoutResult;
  /** Why the runtime offers no logout. */
  readonly unsupported?: string;
  /** The probe or the logout threw. */
  readonly error?: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runLogout(runtime: Runtime, timeoutMs?: number): Promise<LogoutReport> {
  const runtimeId = runtime.id;
  try {
    if (runtime.installation === undefined) {
      return { runtimeId, unsupported: `${runtimeId} exposes no installation probe` };
    }
    const installation = await runtime.installation();
    if (installation.kind !== "available") {
      return { runtimeId, installation };
    }
    if (runtime.logout === undefined) {
      return { runtimeId, unsupported: `${runtimeId} has no logout oar can drive` };
    }
    return { runtimeId, result: await runtime.logout(installation, timeoutMs === undefined ? {} : { timeoutMs }) };
  } catch (error) {
    return { runtimeId, error: message(error) };
  }
}

export function renderLogoutReport(report: LogoutReport): string {
  const { runtimeId, result } = report;
  if (report.error !== undefined) {
    return `${runtimeId}\terror: ${report.error}`;
  }
  if (report.installation !== undefined) {
    return `${runtimeId}\tnot available (${report.installation.kind})`;
  }
  if (result === undefined) {
    return `${runtimeId}\t${report.unsupported ?? "no logout"}`;
  }
  switch (result.kind) {
    case "logged_out":
      return `${runtimeId}\tlogged out`;
    case "failed":
      return `${runtimeId}\tlogout failed: ${result.reason}${result.detail === undefined ? "" : ` (${result.detail})`}`;
    case "unsupported":
      break;
  }
  return `${runtimeId}\tlogout unsupported: ${result.reason}${result.detail === undefined ? "" : ` (${result.detail})`}`;
}

/** As for `oar login`: 0 logged out, 1 otherwise (Ctrl-C ends the command with 130). */
export function logoutExitCode(report: LogoutReport): number {
  return report.result?.kind === "logged_out" ? 0 : 1;
}

/** `oar logout <runtime>`: sign a runtime out through its own logout. */
export function registerLogoutCommand(program: Command, selected: (id: string | undefined) => readonly Runtime[]): void {
  program
    .command("logout <runtime>")
    .description("Log a runtime out through its own logout; its status query must then read logged out")
    .option("--json", "print the result as JSON")
    .option("--timeout <ms>", "bound for the runtime's logout in milliseconds")
    .action(async (id: string, flags: { json?: boolean; timeout?: string }) => {
      const timeoutMs = flags.timeout === undefined ? undefined : Number(flags.timeout);
      if (timeoutMs !== undefined && !(Number.isInteger(timeoutMs) && timeoutMs > 0)) {
        process.stderr.write("--timeout must be a positive integer number of milliseconds\n");
        process.exitCode = 1;
        return;
      }
      const [runtime, ...others] = selected(id);
      if (runtime === undefined || others.length > 0) {
        process.stderr.write("name one runtime to sign out, e.g. `oar logout claude`\n");
        process.exitCode = 1;
        return;
      }
      const report = await runLogout(runtime, timeoutMs);
      process.exitCode = logoutExitCode(report);
      process.stdout.write(flags.json === true ? `${JSON.stringify({ result: report })}\n` : `${renderLogoutReport(report)}\n`);
    });
}
