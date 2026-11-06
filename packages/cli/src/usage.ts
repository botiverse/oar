import { Command } from "commander";
import type { AccountUsageSnapshot, RuntimeRegistry } from "@botiverse/oar";
import { isRuntimeFailure, readEach } from "./each-runtime.js";
import { collectEnv, parseEnvOptions } from "./env-option.js";

const CAPABILITY_UNAVAILABLE: AccountUsageSnapshot = { kind: "unsupported", reason: "capability_unavailable" };
const NO_ENV_OVERRIDES: string[] = [];

interface Flags {
  readonly env?: string[];
}

/** One standalone command for registration and parser-level tests. */
export function usageCommand(registry: RuntimeRegistry): Command {
  return new Command("usage")
    .argument("[runtime]")
    .description("Read account usage for each available installation")
    .option("--env <KEY=VALUE>", "session env overlay for the read (repeatable); e.g. KIMI_CODE_HOME selects the account credential slot", collectEnv, NO_ENV_OVERRIDES)
    .action(async (id: string | undefined, flags: Flags) => {
      const selected = id === undefined ? registry.list() : [registry.require(id)];
      const env = parseEnvOptions(flags.env);
      const reports = await readEach(selected, async (runtime) => {
        if (runtime.accountUsage === undefined || runtime.installation === undefined) {
          return { runtimeId: runtime.id, accountUsage: CAPABILITY_UNAVAILABLE };
        }
        const installation = await runtime.installation();
        if (installation.kind !== "available") {
          return { runtimeId: runtime.id, installation, accountUsage: null };
        }
        const accountUsage = await runtime.accountUsage(installation, env === undefined ? {} : { env });
        return { runtimeId: runtime.id, accountUsage };
      });
      if (reports.some((report) => isRuntimeFailure(report))) { process.exitCode = 1; }
      process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
    });
}
