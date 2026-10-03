#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  openVoyage,
  promptAndWait,
  runtimes,
  type EventObserver,
  type RawEventObserver,
  type Runtime,
} from "@botiverse/oar";
import { readModels, renderModels } from "./models.js";
import { createProgressRenderer, renderOpened } from "./progress.js";
import { registerUpgradeCommand } from "./upgrade.js";
import { registerLoginCommand } from "./login.js";
import { registerMcpCommand } from "./mcp-command.js";

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
    const result = await Promise.all(selected(id).map(async (runtime) => ({
      runtimeId: runtime.id,
      installation: runtime.installation === undefined ? null : await runtime.installation(),
    })));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });

program
  .command("usage [runtime]")
  .description("Read account usage for each available installation")
  .action(async (id: string | undefined) => {
    const result = await Promise.all(selected(id).map(async (runtime) => {
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
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
      const results = await Promise.all(selected(id).map(async (runtime) => {
        const installation = await runtime.installation?.();
        if (installation?.kind !== "available") {
          return { runtimeId: runtime.id, installation: installation ?? null, inventory: null };
        }
        return { runtimeId: runtime.id, inventory: await runtime[method](installation, options) };
      }));
      process.stdout.write(`${JSON.stringify(results, null, 2)  }\n`);
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
    const reports = await Promise.all(selected(id).map(async (runtime) => {
      const report = await readModels(runtime, timeoutMs === undefined ? undefined : { timeoutMs });
      return report;
    }));
    if (flags.json === true) {
      process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
      return;
    }
    for (const report of reports) {
      for (const line of renderModels(report)) {
        process.stdout.write(`${line}\n`);
      }
    }
  });

registerUpgradeCommand(program, selected);
registerLoginCommand(program, selected);
registerMcpCommand(program, packageVersion());

const jsonObserver: RawEventObserver = (record) => {
  process.stdout.write(`${JSON.stringify(record)}\n`);
};

function progressObserver(runtimeId: string): EventObserver {
  const render = createProgressRenderer(runtimeId);
  return (event) => {
    for (const line of render(event)) {
      process.stdout.write(`${line}\n`);
    }
  };
}

program
  .command("run <runtime> <prompt>")
  .description("Run one turn in a fresh (or --resume'd) session and show its progress")
  .option("--model <model>", "runtime-native model identifier")
  .option("--effort <level>", "runtime-native reasoning-effort level (one of the model's effort levels in `oar models`)")
  .option("--resume <sessionId>", "resume the runtime-native session a previous run printed")
  .option("--json", "print the session records as JSON lines instead of progress")
  .option("--record <file>", "write the run as an oar-voyage/3 JSONL log")
  .option("--image <file...>", "send image files with the prompt (png, jpeg, gif, webp), as the runtime's own image input")
  .action(async (
    id: string,
    prompt: string,
    flags: { model?: string; effort?: string; resume?: string; json?: boolean; record?: string; image?: string[] },
  ) => {
    const runtime = runtimes.require(id);
    if (runtime.installation === undefined) {
      process.stderr.write(`${id} has no installation capability\n`);
      process.exitCode = 1;
      return;
    }
    const installation = await runtime.installation();
    if (installation.kind !== "available") {
      process.stderr.write(`${id} is not available: ${installation.kind}\n`);
      process.exitCode = 1;
      return;
    }
    // A refused open (an effort the runtime would not run, a resume id it
    // does not know) is the runtime's answer, not a crash.
    const session = await runtime.session(installation, {
      cwd: process.cwd(),
      ...(flags.model === undefined ? {} : { model: flags.model }),
      ...(flags.effort === undefined ? {} : { effort: flags.effort }),
      ...(flags.resume === undefined ? {} : { resume: flags.resume }),
    }).catch((error: unknown) => {
      process.stderr.write(`${id} session did not open: ${error instanceof Error ? error.message : String(error)}\n`);
      return null;
    });
    if (session === null) {
      process.exitCode = 1;
      return;
    }
    const recorder = flags.record === undefined
      ? undefined
      : openVoyage(flags.record, {
          runtime: id,
          ...(flags.model === undefined ? {} : { model: flags.model }),
          ...(flags.effort === undefined ? {} : { effort: flags.effort }),
          cwd: process.cwd(),
          sessionId: session.id,
          startedAt: Date.now(),
          recorder: `oar-cli/${packageVersion()}`,
        });
    // Replay from the start so the log and the output carry the records the
    // adapter stamped while opening (model, handshake frames), not only what
    // arrives after this subscription.
    const cursor = { sessionId: session.id, afterSeq: -1 };
    session.rawEvents((record) => {
      recorder?.record(record);
      if (flags.json === true) {
        jsonObserver(record);
      }
    }, cursor);
    if (flags.json !== true) {
      process.stdout.write(`${renderOpened({
        sessionId: session.id,
        resumed: flags.resume !== undefined,
        model: session.model().value,
        effort: session.effort().value,
      })}\n`);
      session.events(progressObserver(id), { cursor, coalesceText: { maxHoldMs: 250 } });
    }
    // The runtime leads its own process group, so the terminal's Ctrl-C
    // reaches this process only. The first one interrupts the turn (the
    // session is then disposed as usual), a later one disposes at once; the
    // handler stays until the dispose settles, so the runtime and everything
    // it started are always taken down with the run.
    const interrupt = new AbortController();
    // A repeated dispose() returns at once; the run waits for the first one.
    let disposal: Promise<void> | null = null;
    const dispose = async (): Promise<void> => {
      disposal ??= session.dispose();
      await disposal;
    };
    const onInterrupt = (): void => {
      if (interrupt.signal.aborted) {
        void dispose();
      } else {
        interrupt.abort();
      }
    };
    process.on("SIGINT", onInterrupt);
    const images = flags.image?.map((file) => ({ path: path.resolve(file) }));
    const run = await promptAndWait(session, prompt, { signal: interrupt.signal, ...(images === undefined ? {} : { images }) });
    await dispose();
    process.off("SIGINT", onInterrupt);
    recorder?.end("disposed");
    if (run.kind === "rejected") {
      process.stderr.write(`prompt not accepted (${run.code}): ${run.reason}\n`);
      process.exitCode = 1;
      return;
    }
    const { outcome } = run;
    if (flags.json === true) {
      process.stdout.write(`${JSON.stringify({ outcome })}\n`);
    }
    if (run.kind === "interrupted" && run.by === "signal") {
      process.exitCode = 130;
      return;
    }
    process.exitCode = outcome.kind === "completed" ? 0 : 1;
  });

await program.parseAsync();
