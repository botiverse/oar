#!/usr/bin/env node
/* oxlint-disable import/max-dependencies -- the CLI composition root registers independently owned commands. */
import { readFileSync } from "node:fs";
import { Argument, Command } from "commander";
import type { InstallationSnapshot, Runtime } from "@botiverse/oar";
import { isRuntimeFailure, readEach, type RuntimeFailure } from "./each-runtime.js";
import { readUsage, renderUsageReport } from "./usage.js";
import { readModels, renderModels } from "./models.js";
import { registerInstallCommand } from "./install.js";
import { registerUpgradeCommand } from "./upgrade.js";
import { registerLoginCommand, registerLogoutCommand, registerStatusCommand } from "./login.js";
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
  .description([
    "OAR (Open Agent Runtime): one programming interface for coding-agent runtimes.",
    "Install, sign in, read usage and models, and run turns on Claude Code, Codex,",
    "Cursor, Grok, Kimi, OpenCode, Pi, Qwen and more, each through its own native interface.",
  ].join("\n"))
  .version(packageVersion())
  .addHelpText("after", [
    "",
    "Examples:",
    "  oar installation              which runtimes are installed here, and their versions",
    "  oar install codex --plan      show what the official installer would run",
    "  oar account login claude      sign in through the runtime's own login",
    "  oar account usage             plan, usage windows and resets for each runtime",
    "  oar run codex \"fix the test\"  run one turn and show its progress",
    "",
    "Docs:      https://github.com/botiverse/oar#readme",
    "Runtimes:  https://github.com/botiverse/oar/tree/main/docs/runtimes",
    "Library:   npm install @botiverse/oar",
  ].join("\n"));

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

registerInstallCommand(program, (id) => runtimes.require(id));
registerUpgradeCommand(program, selected);

function renderInstallation(report: { readonly runtimeId: string; readonly installation: InstallationSnapshot | null } | RuntimeFailure): string {
  if (isRuntimeFailure(report)) {
    return `${report.runtimeId}\terror: ${report.error}`;
  }
  const { installation } = report;
  if (installation === null) {
    return `${report.runtimeId}\tno installation probe`;
  }
  switch (installation.kind) {
    case "available":
      return installation.via === "bundled"
        ? `${report.runtimeId}\tbundled with oar`
        : `${report.runtimeId}\t${installation.version ?? "unknown version"}\t${installation.command}`;
    case "not_found":
      return `${report.runtimeId}\tnot installed`;
    case "unsupported":
      break;
  }
  return `${report.runtimeId}\tunsupported: ${installation.reason}`;
}

program
  .command("installation [runtime]")
  .description("Which runtimes are installed here, their versions and where; no account I/O")
  .option("--json", "print the full installation snapshots as JSON")
  .action(async (id: string | undefined, flags: { json?: boolean }) => {
    const reports = await readEach(selected(id), async (runtime) => ({
      runtimeId: runtime.id,
      installation: runtime.installation === undefined ? null : await runtime.installation(),
    }));
    if (flags.json === true) {
      printEach(reports);
      return;
    }
    exitOnFailure(reports);
    process.stdout.write(reports.map((report) => `${renderInstallation(report)}\n`).join(""));
  });

const account = program
  .command("account")
  .description("Sign runtimes in and out, see who is signed in, and read account usage");
registerLoginCommand(account, selected);
registerLogoutCommand(account, selected);
registerStatusCommand(account, selected);
account
  .command("usage [runtime]")
  .description("Account usage for each available installation: plan, windows used and their resets")
  .option("--json", "print the AccountUsageSnapshot per runtime as JSON")
  .action(async (id: string | undefined, flags: { json?: boolean }) => {
    const reports = await readEach(selected(id), readUsage);
    if (flags.json === true) {
      printEach(reports);
      return;
    }
    exitOnFailure(reports);
    process.stdout.write(reports.flatMap((report) => renderUsageReport(report)).map((line) => `${line}\n`).join(""));
  });

const inventories = { skills: "skills", commands: "commands", mcps: "mcpServers", tools: "tools" } as const;
program
  .command("inventory")
  .description("Query a native inventory for a working directory (JSON), for troubleshooting")
  .addArgument(new Argument("<kind>", "which inventory").choices(Object.keys(inventories)))
  .argument("[runtime]")
  .option("--cwd <directory>", "working directory; defaults to process.cwd()")
  .option("--timeout <ms>", "per-runtime timeout in milliseconds")
  .action(async (kind: keyof typeof inventories, id: string | undefined, flags: { cwd?: string; timeout?: string }) => {
    const timeoutMs = flags.timeout === undefined ? undefined : Number(flags.timeout);
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
      program.error("--timeout must be a positive integer");
    }
    const options = {
      ...(flags.cwd === undefined ? {} : { cwd: flags.cwd }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
    const method = inventories[kind];
    printEach(await readEach(selected(id), async (runtime) => {
      const installation = await runtime.installation?.();
      if (installation?.kind !== "available") {
        return { runtimeId: runtime.id, installation: installation ?? null, inventory: null };
      }
      return { runtimeId: runtime.id, inventory: await runtime[method](installation, options) };
    }));
  });

program
  .command("models [runtime]")
  .description("List models each available installation can run right now")
  .option("--json", "print the ListModelsResult per runtime as JSON")
  .option("--cwd <directory>", "directory a session would run in, whose project config can change the list; defaults to process.cwd()")
  .option("--timeout <ms>", "per-runtime listing timeout in milliseconds")
  .action(async (id: string | undefined, flags: { json?: boolean; cwd?: string; timeout?: string }) => {
    const timeoutMs = flags.timeout === undefined ? undefined : Number(flags.timeout);
    if (timeoutMs !== undefined && !(Number.isInteger(timeoutMs) && timeoutMs > 0)) {
      process.stderr.write("--timeout must be a positive integer number of milliseconds\n");
      process.exitCode = 1;
      return;
    }
    const options = {
      ...(flags.cwd === undefined ? {} : { cwd: flags.cwd }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
    const reports = await readEach(selected(id), async (runtime) => {
      const report = await readModels(runtime, options);
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

registerMcpCommand(program, packageVersion());
registerRunCommand(program, packageVersion());

await program.parseAsync();
