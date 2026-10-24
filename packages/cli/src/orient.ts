import { Option, Command } from "commander";
import { orient, type Orientation, type OrientationDepth, type RuntimeRegistry } from "@botiverse/oar";
import { usability } from "@botiverse/oar/observe";

interface Flags {
  readonly depth: OrientationDepth;
  readonly json?: boolean;
  readonly customization?: boolean;
  readonly timeout?: string;
}

/** The JSON form carries all evidence; the table is a compact readiness projection. */
export function renderOrientation(snapshot: Orientation): string {
  const readiness = usability(snapshot);
  const rows = snapshot.runtimes.map((runtime, index) => {
    const state = readiness[index];
    const auth = runtime.auth.kind === "ok" ? runtime.auth.value : undefined;
    const account = auth?.kind === "logged_in" ? auth.account : undefined;
    const installation = runtime.installation.kind === "ok" ? runtime.installation.value : undefined;
    const version = installation?.kind === "available" && installation.via === "executable" ? installation.version : undefined;
    const providers = runtime.providers?.kind === "ok" ? runtime.providers.value : undefined;
    return [runtime.id, version ?? "", state?.usable === true ? "ready" : state?.because ?? "unknown",
      account?.credential ?? account?.method ?? "", account?.metering ?? "", account?.plan ?? "",
      ...(providers === undefined ? [] : [`providers: ${providers.filter((provider) => provider.configured).map((provider) => provider.providerId).join(", ")}`]),
      ...(runtime.models?.kind === "ok" ? [`models: ${String(runtime.models.value.length)}`] : []),
    ].join("\t");
  });
  return [`Observed ${snapshot.observedAt} (${snapshot.depth})`, "runtime\tversion\treadiness\tcredential\tmetering\tplan", ...rows].join("\n");
}

export function registerOrientCommand(program: Command, registry: RuntimeRegistry): void {
  program.addCommand(orientationCommand(registry));
}

/** One standalone command for registration and parser-level tests. */
export function orientationCommand(registry: RuntimeRegistry): Command {
  const command = new Command("orient").argument("[runtime...]");
  return command
    .description("Read bounded installation and account facts without opening a model turn")
    .addOption(new Option("--depth <depth>", "local metadata, account I/O, or model catalogs").choices(["local", "account", "models"]).default("local"))
    .option("--json", "print the complete observation snapshot")
    .option("--customization", "run native inventories in an empty directory; can execute user configuration and connect MCP servers")
    .option("--timeout <ms>", "overall deadline in milliseconds (default 60000)")
    .action(async (ids: string[], flags: Flags) => {
      const timeoutMs = flags.timeout === undefined ? undefined : Number(flags.timeout);
      if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)) {
        command.error("--timeout must be a positive integer that fits a timer");
      }
      const snapshot = await orient(registry, {
        depth: flags.depth,
        ...(ids.length === 0 ? {} : { runtimes: ids }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(flags.customization === true ? { include: ["customization"] } : {}),
      });
      process.stdout.write(`${flags.json === true ? JSON.stringify(snapshot, null, 2) : renderOrientation(snapshot)}\n`);
    });
}
