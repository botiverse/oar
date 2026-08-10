/**
 * `oar` CLI entry.
 *
 * Deliberately a thin shell over already-merged modules: no detection logic, no
 * schema logic, no formatting rules that do not already exist. Anything this
 * file decides for itself is a second source of truth waiting to drift from the
 * library, which is the failure this project has been paying down all week.
 */

import { Command } from "commander";
import { spawn } from "node:child_process";
import { detectAllRegistered, type RuntimeDescriptor } from "./discovery/detect.js";
import { createHostDrivers } from "./discovery/host/runtimeDrivers.js";
import { RAFT_DRIVER_REGISTRY } from "./discovery/fixtures/raftRuntimes.js";

/**
 * Human-readable status for one runtime.
 *
 * The four failure states are printed verbatim and never merged. `needs_login`
 * and `models_unavailable` in particular describe different worlds — signed out
 * versus present-but-no-models — and collapsing them into "0 models" is the
 * exact defect this discovery layer was built to fix. A renderer that helpfully
 * simplifies them would silently reintroduce it.
 */
function statusLine(d: RuntimeDescriptor): string {
  const name = (d.label ?? d.runtime).padEnd(14);
  const version = (d.version || "unknown").padEnd(12);
  const modelCount = d.providers?.length
    ? `${d.providers.length} provider(s)`
    : `${d.models.length} model(s)`;
  const failure = d.failure ? `  failure=${d.failure}` : "";
  return `${name} ${version} ${modelCount.padEnd(16)}${failure}`;
}

/**
 * v1 machine projection — deliberately NARROWER than `RuntimeDescriptor`.
 *
 * Consumption boundary set by @Jianwei (`#wg-oar`): Testbed may only eat a
 * versioned, stable projection, never the whole current `detectAll()` shape.
 * `models` is excluded on purpose: its `support → options` structure is still
 * pending §4.2–4.4, so emitting it in v1 would make Testbed a signed-up
 * consumer of a type we already know is going to change. The human table below
 * may still show a model count — Testbed simply does not sign off on that
 * column.
 *
 * `failure` stays a closed set and keeps the explicit unknown states
 * (`detect_failed` / `needs_login` / `models_unavailable`) distinct.
 */
interface DetectV1Row {
  readonly schemaVersion: 1;
  readonly runtime: string;
  readonly version: string;
  readonly failure: RuntimeDescriptor["failure"] | null;
}

function toV1(d: RuntimeDescriptor): DetectV1Row {
  return {
    schemaVersion: 1,
    runtime: d.runtime,
    version: d.version,
    failure: d.failure ?? null,
  };
}

async function runDetect(opts: { json?: boolean }): Promise<void> {
  const descriptors = await detectAllRegistered(createHostDrivers(), RAFT_DRIVER_REGISTRY);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(descriptors.map(toV1), null, 2)}\n`);
    return;
  }

  for (const d of descriptors) process.stdout.write(`${statusLine(d)}\n`);

  const unavailable = descriptors.filter((d) => d.failure).length;
  process.stdout.write(
    `\n${descriptors.length} runtime(s) in registry, ${descriptors.length - unavailable} usable, `
    + `${unavailable} with a failure state.\n`,
  );
}

async function runDemo(opts: { open?: boolean }): Promise<void> {
  // The demo HTML is produced by the existing bake script; shelling out to it
  // keeps one builder rather than a second copy that can drift.
  const script = new URL("../scripts/bake-create-agent-demo.ts", import.meta.url).pathname;
  const child = spawn("npx", ["--yes", "tsx", script], {
    stdio: opts.open ? "inherit" : ["ignore", "inherit", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    child.on("exit", (code) => { if (code === 0) { resolve(); } else { reject(new Error(`bake exited ${code}`)); } });
    child.on("error", reject);
  });
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("oar")
    .description("oar — agent client access layer")
    .version("0.0.0");

  program
    .command("detect")
    .description("Detect host runtimes and report the four-state status of each")
    .option("--json", "emit raw RuntimeDescriptor[] as JSON")
    .action(async (opts: { json?: boolean }) => {
      await runDetect(opts);
    });

  program
    .command("demo")
    .description("Build the create-agent config form demo (single-file HTML)")
    .option("--open", "pass through to the bake script's interactive mode")
    .action(async (opts: { open?: boolean }) => {
      await runDemo(opts);
    });

  return program;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");
if (invokedDirectly || process.env.OAR_CLI_FORCE_RUN) {
  buildProgram().parseAsync(process.argv).catch((err: unknown) => {
    process.stderr.write(`oar: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
