#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import {
  aggregateDeltas,
  openVoyage,
  runtimes,
  type Runtime,
  type SessionObserver,
} from "@botiverse/oar";
import { createProgressRenderer } from "./progress.js";

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
  .description("Observe installed agent runtimes and account usage")
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
        return { runtimeId: runtime.id, accountUsage: { kind: "unsupported" as const } };
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

const jsonObserver: SessionObserver = (event) => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

function progressObserver(runtimeId: string): SessionObserver {
  const render = createProgressRenderer(runtimeId);
  const renderTo: SessionObserver = (event) => {
    const line = render(event);
    if (line !== null) {
      process.stdout.write(`${line}\n`);
    }
  };
  return aggregateDeltas(renderTo, { maxHoldMs: 250 });
}

program
  .command("run <runtime> <prompt>")
  .description("Run one turn in a fresh session and show its progress")
  .option("--model <model>", "runtime-native model identifier")
  .option("--json", "print raw session events as JSON lines instead of progress")
  .option("--record <file>", "write the run as an oar-voyage/1 JSONL log")
  .action(async (
    id: string,
    prompt: string,
    flags: { model?: string; json?: boolean; record?: string },
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
    const session = await runtime.session(installation, {
      cwd: process.cwd(),
      ...(flags.model === undefined ? {} : { model: flags.model }),
    });
    const recorder = flags.record === undefined
      ? undefined
      : openVoyage(flags.record, {
          runtime: id,
          ...(flags.model === undefined ? {} : { model: flags.model }),
          cwd: process.cwd(),
          sessionId: session.id,
          startedAt: Date.now(),
          recorder: `oar-cli/${packageVersion()}`,
        });
    const print = flags.json === true ? jsonObserver : progressObserver(id);
    session.subscribe((event) => {
      recorder?.event(event);
      print(event);
    });
    recorder?.submission("prompt", prompt);
    const result = session.prompt(prompt);
    if (result.kind !== "turn") {
      process.stderr.write("session is busy\n");
      await session.dispose();
      recorder?.end("disposed");
      process.exitCode = 1;
      return;
    }
    const outcome = await result.turn.outcome;
    await session.dispose();
    recorder?.end("disposed");
    if (flags.json === true) {
      process.stdout.write(`${JSON.stringify({ outcome })}\n`);
    }
    process.exitCode = outcome.kind === "completed" ? 0 : 1;
  });

await program.parseAsync();
