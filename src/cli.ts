/**
 * `oar` CLI entry.
 *
 * Thin shell over library modules. Detection logic lives in discovery/; this
 * file only chooses presentation (table / json / profile / debug).
 */

import { Command } from "commander";
import { spawn } from "node:child_process";
import {
  detectAllRegistered,
  type RuntimeDescriptor,
  type RuntimeTimings,
  MODELS_PROBE_BUDGET_MS,
} from "./discovery/detect.js";
import { createHostDrivers } from "./discovery/host/runtimeDrivers.js";
import { RAFT_DRIVER_REGISTRY } from "./discovery/fixtures/raftRuntimes.js";
import type { AccountUsageSnapshot } from "./discovery/accountUsage.js";
import { USAGE_PROVIDERS } from "./discovery/accountUsage.js";
import { collectUsage, collectUsageAll, parseUsageProvider } from "./discovery/usageCollect.js";

/**
 * Human-readable status for one runtime.
 * Failure states print verbatim and never merge.
 */
function statusLine(d: RuntimeDescriptor): string {
  const name = (d.label ?? d.runtime).padEnd(14);
  const version = (d.version || "unknown").padEnd(12);
  const modelCount = d.providers?.length
    ? `${d.providers.length} provider(s) / ${d.providers.reduce((n, p) => n + p.models.length, 0)} model(s)`
    : `${d.models.length} model(s)`;
  const failure = d.failure ? `  failure=${d.failure}` : "";
  return `${name} ${version} ${modelCount.padEnd(28)}${failure}`;
}

function formatTimings(t: RuntimeTimings | undefined): string {
  if (!t) return "  timings=-";
  const models = t.modelsMs === null ? "-" : `${Math.round(t.modelsMs)}ms`;
  return `  detect=${Math.round(t.detectMs)}ms models=${models} total=${Math.round(t.totalMs)}ms`;
}

/** Print every model (and provider axis when present). */
function writeModelsDetail(d: RuntimeDescriptor): void {
  if (d.providers && d.providers.length > 0) {
    for (const p of d.providers) {
      process.stdout.write(`  [${p.id}] ${p.label}\n`);
      if (p.models.length === 0) {
        process.stdout.write(`    (no models)\n`);
        continue;
      }
      for (const m of p.models) {
        const opts =
          m.options.length > 0
            ? `  options=${m.options.map((o) => o.id).join(",")}`
            : "";
        process.stdout.write(`    ${m.id.padEnd(40)} ${m.label}${opts}\n`);
      }
    }
    return;
  }
  if (d.models.length === 0) {
    process.stdout.write(`  (no models)\n`);
    return;
  }
  for (const m of d.models) {
    const opts =
      m.options.length > 0 ? `  options=${m.options.map((o) => o.id).join(",")}` : "";
    process.stdout.write(`  ${m.id.padEnd(40)} ${m.label}${opts}\n`);
  }
}

/**
 * v1 machine projection for full-board detect — deliberately NARROWER than RuntimeDescriptor.
 * models excluded (Jianwei). timings is additive metadata Testbed may ignore.
 */
interface DetectV1Row {
  readonly schemaVersion: 1;
  readonly runtime: string;
  readonly version: string;
  readonly failure: RuntimeDescriptor["failure"] | null;
  readonly timings: {
    readonly unit: "ms";
    readonly detectMs: number;
    readonly modelsMs: number | null;
    readonly totalMs: number;
    readonly modelsBudgetMs: number;
  };
}

function toV1(d: RuntimeDescriptor): DetectV1Row {
  const t = d.timings ?? { detectMs: 0, modelsMs: null, totalMs: 0 };
  return {
    schemaVersion: 1,
    runtime: d.runtime,
    version: d.version,
    failure: d.failure ?? null,
    timings: {
      unit: "ms",
      detectMs: t.detectMs,
      modelsMs: t.modelsMs,
      totalMs: t.totalMs,
      modelsBudgetMs: MODELS_PROBE_BUDGET_MS,
    },
  };
}

/** Single-runtime detail JSON — includes models (human asked to list them). */
function toDetailJson(d: RuntimeDescriptor) {
  return {
    ...toV1(d),
    models: d.models.map((m) => ({
      id: m.id,
      label: m.label,
      options: m.options.map((o) => o.id),
    })),
    providers: d.providers?.map((p) => ({
      id: p.id,
      label: p.label,
      models: p.models.map((m) => ({
        id: m.id,
        label: m.label,
        options: m.options.map((o) => o.id),
      })),
    })),
  };
}

async function runDetect(opts: {
  runtime?: string;
  json?: boolean;
  profile?: boolean;
  debug?: boolean;
}): Promise<void> {
  if (opts.debug) {
    process.stderr.write(
      "oar detect --debug: command-level trace not yet wired through host drivers; "
        + "use --profile for phase timings. Full allowlist capture lands next.\n",
    );
  }

  const allDrivers = createHostDrivers();
  const runtimeFilter = opts.runtime?.trim();

  if (runtimeFilter) {
    const known = new Set<string>([...RAFT_DRIVER_REGISTRY, ...allDrivers.map((d) => d.id)]);
    if (!known.has(runtimeFilter)) {
      process.stderr.write(
        `oar: unknown runtime "${runtimeFilter}". registry: ${RAFT_DRIVER_REGISTRY.join(", ")}\n`,
      );
      process.exitCode = 1;
      return;
    }
  }

  // Single-runtime: only run that driver (avoids spawnSync event-loop starvation
  // from probing every CLI in parallel) and give models phase more headroom.
  const drivers = runtimeFilter
    ? allDrivers.filter((d) => d.id === runtimeFilter)
    : allDrivers;
  const registry = runtimeFilter
    ? ([runtimeFilter] as string[])
    : ([...RAFT_DRIVER_REGISTRY] as string[]);
  const modelsBudgetMs = runtimeFilter ? 30_000 : MODELS_PROBE_BUDGET_MS;

  const descriptors = await detectAllRegistered(drivers, registry, { modelsBudgetMs });

  if (opts.json) {
    if (runtimeFilter) {
      process.stdout.write(`${JSON.stringify(descriptors.map(toDetailJson), null, 2)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(descriptors.map(toV1), null, 2)}\n`);
    }
    return;
  }

  for (const d of descriptors) {
    let line = statusLine(d);
    if (opts.profile) line += formatTimings(d.timings);
    process.stdout.write(`${line}\n`);
    // `oar detect <runtime>` always lists every model.
    if (runtimeFilter) writeModelsDetail(d);
  }

  if (!runtimeFilter) {
    const unavailable = descriptors.filter((d) => d.failure).length;
    process.stdout.write(
      `\n${descriptors.length} runtime(s) in registry, ${descriptors.length - unavailable} usable, `
        + `${unavailable} with a failure state.\n`,
    );
  }

  if (opts.profile) {
    const sum = descriptors.reduce((s, d) => s + (d.timings?.totalMs ?? 0), 0);
    const wall = Math.max(...descriptors.map((d) => d.timings?.totalMs ?? 0), 0);
    process.stdout.write(
      `profile: sum(totalMs)=${Math.round(sum)} wall≈max(totalMs)=${Math.round(wall)} `
        + `modelsBudgetMs=${modelsBudgetMs}\n`,
    );
    for (const d of descriptors) {
      const total = d.timings?.totalMs ?? 0;
      if (total >= 1000) {
        process.stderr.write(
          `oar: slow probe ${d.runtime} total=${Math.round(total)}ms\n`,
        );
      }
    }
  }
}

async function runDemo(opts: { open?: boolean }): Promise<void> {
  const script = new URL("../scripts/bake-create-agent-demo.ts", import.meta.url).pathname;
  const child = spawn("npx", ["--yes", "tsx", script], {
    stdio: opts.open ? "inherit" : ["ignore", "inherit", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`bake exited ${code}`));
    });
    child.on("error", reject);
  });
}

function writeUsageHuman(snap: AccountUsageSnapshot): void {
  process.stdout.write(
    `${snap.provider}  health=${snap.accounts.map((a) => a.health).join(",")}  `
      + `acquisition=${snap.acquisition}  scope=${snap.scope}\n`,
  );
  if (snap.sourceVersion) {
    process.stdout.write(`  source=${snap.sourceVersion}\n`);
  }
  if (snap.acquisition === "text_parse" || snap.scope === "local_sessions_only") {
    process.stdout.write(
      "  caveat=approximate / rendered-cli or local-session estimate — not the same "
        + "authority as codex structured rateLimits\n",
    );
  }
  for (const acc of snap.accounts) {
    if (acc.planLabel) process.stdout.write(`  plan=${acc.planLabel}\n`);
    if (acc.maskedLabel) process.stdout.write(`  account=${acc.maskedLabel}\n`);
    if (acc.parseErrorCode) process.stdout.write(`  parseError=${acc.parseErrorCode}\n`);
    if (acc.windows.length === 0) {
      process.stdout.write(`  (no usage windows)\n`);
      continue;
    }
    for (const w of acc.windows) {
      const pct =
        w.usedRatio === undefined ? "—" : `${Math.round(w.usedRatio * 1000) / 10}%`;
      const reset = w.resetsAt ? `  resets=${w.resetsAt}` : "";
      process.stdout.write(
        `  ${w.id.padEnd(28)} ${w.label.padEnd(28)} status=${w.status}  used=${pct}${reset}\n`,
      );
    }
  }
}

async function runUsage(opts: {
  provider?: string;
  json?: boolean;
}): Promise<void> {
  const parsed = parseUsageProvider(opts.provider);
  if (parsed === null) {
    process.stderr.write(
      `oar: unknown usage provider "${opts.provider}". `
        + `supported: ${USAGE_PROVIDERS.join(", ")} (or omit for all)\n`,
    );
    process.exitCode = 1;
    return;
  }

  const snaps =
    parsed === "all" ? await collectUsageAll() : [await collectUsage(parsed)];

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(parsed === "all" ? snaps : snaps[0], null, 2)}\n`);
    return;
  }

  for (const snap of snaps) {
    writeUsageHuman(snap);
    process.stdout.write("\n");
  }
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("oar")
    .description("oar — agent client access layer")
    .version("0.0.0");

  program
    .command("detect")
    .description(
      "Detect host runtimes (four-state). Optional <runtime> probes only that id and lists all models.",
    )
    .argument("[runtime]", "runtime id (e.g. pi, codex, kimi) — list all models for that runtime")
    .option("--json", "emit JSON (full board: v1 narrow; single runtime: includes models)")
    .option("--profile", "human table with per-runtime phase timings (ms)")
    .option("--debug", "emit probe debug on stderr (not mixed into --json stdout)")
    .action(
      async (
        runtime: string | undefined,
        opts: { json?: boolean; profile?: boolean; debug?: boolean },
      ) => {
        await runDetect({
          ...opts,
          ...(runtime !== undefined ? { runtime } : {}),
        });
      },
    );

  program
    .command("demo")
    .description("Build the create-agent config form demo (single-file HTML)")
    .option("--open", "pass through to the bake script's interactive mode")
    .action(async (opts: { open?: boolean }) => {
      await runDemo(opts);
    });

  program
    .command("usage")
    .description(
      "Read host account usage / rate limits (separate from detect four-state). "
        + "codex/claude/kimi collectors; grok returns unsupported until a surface exists.",
    )
    .argument(
      "[provider]",
      `provider id (${USAGE_PROVIDERS.join("|")}); omit for all`,
    )
    .option("--json", "emit AccountUsageSnapshot JSON (protocol v1 mirror of raft)")
    .action(async (provider: string | undefined, opts: { json?: boolean }) => {
      await runUsage({
        ...opts,
        ...(provider !== undefined ? { provider } : {}),
      });
    });

  return program;
}

const invokedDirectly =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");
if (invokedDirectly || process.env.OAR_CLI_FORCE_RUN) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      process.stderr.write(`oar: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
