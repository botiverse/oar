#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import type { Runtime } from "@botiverse/oar";
import { isRuntimeFailure, readEach, type RuntimeFailure } from "./each-runtime.js";
import { readModels, renderModels } from "./models.js";
import { registerUpgradeCommand } from "./upgrade.js";
import { registerLoginCommand } from "./login.js";
import { registerMcpCommand } from "./mcp-command.js";
import { registerRunCommand } from "./run.js";
import { runtimes } from "./runtimes.js";

// Read the version from this package's own manifest so `--version` can never
// drift from package.json. `../package.json` resolves to the package root in
// both src (packages/cli) and the published tarball (package/dist -> package).
function packageVersion(): string {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  return typeof parsed === "object" && parsed !== null && "version" in parsed
    && typeof parsed.version === "string"
    ? parsed.version
    : "0.0.0";
}

const program = new Command()
  .name("oar")
  .description("Observe and run installed agent runtimes")
  .version(packageVersion());

function selected(id: string | undefined): readonly Runtime[] {
  return id === undefined || id === "all" ? runtimes.list() : [runtimes.require(id)];
}

function renderFailure(report: RuntimeFailure): string[] {
  return [`${report.runtimeId}: error: ${report.error}`];
}

/** A runtime that could not be read makes the exit code 1. */
function exitOnFailure(reports: readonly object[]): void {
  if (reports.some((report) => isRuntimeFailure(report))) {
    process.exitCode = 1;
  }
}

function printEach(reports: readonly object[]): void {
  exitOnFailure(reports);
  process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
}

program
  .command("list")
  .description("List registered runtimes and their capabilities")
  .action(() => {
    const result = runtimes.list().map((runtime) => ({
      id: runtime.id,
      session: true,
      installation: runtime.installation !== undefined,
      accountUsage: runtime.accountUsage !== undefined,
      listModels: runtime.listModels !== undefined,
      checkUpdate: runtime.checkUpdate !== undefined,
      upgrade: runtime.upgrade !== undefined,
      login: runtime.login !== undefined,
      authStatus: runtime.authStatus !== undefined,
    }));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });

program
  .command("installation [runtime]")
  .alias("detect")
  .description("Probe local runtime installation without account or usage I/O")
  .action(async (id: string | undefined) => {
    printEach(await readEach(selected(id), async (runtime) => ({
      runtimeId: runtime.id,
      installation: runtime.installation === undefined ? null : await runtime.installation(),
    })));
  });

program
  .command("usage [runtime]")
  .description("Read account usage for each available installation")
  .action(async (id: string | undefined) => {
    printEach(await readEach(selected(id), async (runtime) => {
      if (runtime.accountUsage === undefined || runtime.installation === undefined) {
        return { runtimeId: runtime.id, accountUsage: { kind: "unsupported" as const, reason: "capability_unavailable" as const } };
      }
      const installation = await runtime.installation();
      if (installation.kind !== "available") {
        return { runtimeId: runtime.id, installation, accountUsage: null };
      }
      const accountUsage = await runtime.accountUsage(installation);
      return { runtimeId: runtime.id, accountUsage };
    }));
  });

for (const [command, method] of [["skills", "skills"], ["mcps", "mcpServers"], ["tools", "tools"]] as const) {
  program.command(`${command  } [runtime]`)
    .description(`Query native ${  command  } inventory for a working directory (JSON)`)
    .option("--cwd <directory>", "working directory; defaults to process.cwd()")
    .option("--timeout <ms>", "per-runtime timeout in milliseconds")
    .action(async (id: string | undefined, flags: { cwd?: string; timeout?: string }) => {
      const timeoutMs = flags.timeout === undefined ? undefined : Number(flags.timeout);
      if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
        program.error("--timeout must be a positive integer");
      }
      const options = {
        ...(flags.cwd === undefined ? {} : { cwd: flags.cwd }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      };
      printEach(await readEach(selected(id), async (runtime) => {
        const installation = await runtime.installation?.();
        if (installation?.kind !== "available") {
          return { runtimeId: runtime.id, installation: installation ?? null, inventory: null };
        }
        return { runtimeId: runtime.id, inventory: await runtime[method](installation, options) };
      }));
    });
}

program
  .command("models [runtime]")
  .description("List models each available installation can run right now")
  .option("--json", "print the ListModelsResult per runtime as JSON")
  .option("--timeout <ms>", "per-runtime listing timeout in milliseconds")
  .action(async (id: string | undefined, flags: { json?: boolean; timeout?: string }) => {
    const timeoutMs = flags.timeout === undefined ? undefined : Number(flags.timeout);
    if (timeoutMs !== undefined && !(Number.isInteger(timeoutMs) && timeoutMs > 0)) {
      process.stderr.write("--timeout must be a positive integer number of milliseconds\n");
      process.exitCode = 1;
      return;
    }
    const reports = await readEach(selected(id), async (runtime) => {
      const report = await readModels(runtime, timeoutMs === undefined ? undefined : { timeoutMs });
      return report;
    });
    if (flags.json === true) {
      printEach(reports);
      return;
    }
    exitOnFailure(reports);
    for (const report of reports) {
      for (const line of isRuntimeFailure(report) ? renderFailure(report) : renderModels(report)) {
        process.stdout.write(`${line}\n`);
      }
    }
  });

registerUpgradeCommand(program, selected);
registerLoginCommand(program, selected);
registerMcpCommand(program, packageVersion());
registerRunCommand(program, packageVersion());

await program.parseAsync();
