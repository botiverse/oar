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
      installation: runtime.installation === undefined ? null : await runtime.installation.probe(),
    })));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });

program
  .command("usage [runtime]")
  .description("Read account usage independently from installation detection")
  .action(async (id: string | undefined) => {
    const result = await Promise.all(selected(id).map(async (runtime) => {
      const accountUsage = runtime.accountUsage === undefined
        ? { kind: "unsupported" as const }
        : await runtime.accountUsage.read();
      return { runtimeId: runtime.id, accountUsage };
    }));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });

await program.parseAsync();
