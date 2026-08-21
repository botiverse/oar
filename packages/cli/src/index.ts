#!/usr/bin/env node
import { Command } from "commander";
import { runtimes, type Runtime } from "@botiverse/oar";

const program = new Command()
  .name("oar")
  .description("Observe installed agent runtimes and account usage")
  .version("0.0.1");

function selected(id: string | undefined): readonly Runtime[] {
  return id === undefined || id === "all" ? runtimes.list() : [runtimes.require(id)];
}

program
  .command("list")
  .description("List registered runtimes and their capabilities")
  .action(() => {
    const result = runtimes.list().map((runtime) => ({
      id: runtime.id,
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

program
  .command("run <runtime> <prompt>")
  .description("Run one turn in a fresh session and stream its events")
  .option("--model <model>", "runtime-native model identifier")
  .action(async (id: string, prompt: string, flags: { model?: string }) => {
    const runtime = runtimes.require(id);
    if (runtime.session === undefined || runtime.installation === undefined) {
      process.stderr.write(`${id} has no session capability\n`);
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
    session.subscribe((event) => {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    });
    const result = session.prompt(prompt);
    if (result.kind !== "turn") {
      process.stderr.write("session is busy\n");
      process.exitCode = 1;
      return;
    }
    const outcome = await result.turn.outcome;
    await session.dispose();
    process.stdout.write(`${JSON.stringify({ outcome })}\n`);
    process.exitCode = outcome.kind === "completed" ? 0 : 1;
  });

await program.parseAsync();
