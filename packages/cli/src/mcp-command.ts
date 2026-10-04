import path from "node:path";
import type { Command } from "commander";
import { createSubagents } from "@botiverse/oar/agents";
import { serveMcp } from "./mcp.js";
import { subagentTools } from "./mcp-tools.js";
import { runtimes } from "./runtimes.js";

function nonnegative(program: Command, value: string | undefined, flag: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    program.error(`${flag} must be a nonnegative integer`);
  }
  return parsed;
}

interface McpFlags {
  readonly runtimes?: string;
  readonly maxRunning?: string;
  readonly maxDepth?: string;
  readonly cwd?: string;
  readonly logDir?: string;
}

/** `oar mcp`: serve subagents over MCP on stdio. */
export function registerMcpCommand(program: Command, version: string): void {
  program
    .command("mcp")
    .description("Serve subagents over MCP on stdio: let an agent delegate tasks to other runtimes")
    .option("--runtimes <ids>", "comma-separated runtimes subagents may use; all by default")
    .option("--max-running <n>", "subagents whose turn may run at once (default 4)")
    .option("--max-depth <n>", "how deep subagents may nest (default 1: they do not spawn)")
    .option("--cwd <directory>", "working directory for subagents that name none")
    .option("--log-dir <directory>", "write each subagent's records there as an oar-voyage log")
    .action(async (flags: McpFlags) => {
      const allowed = flags.runtimes?.split(",").map((id) => id.trim()).filter((id) => id !== "");
      const offered = runtimes.list().filter((runtime) => allowed === undefined || allowed.includes(runtime.id));
      const maxRunning = nonnegative(program, flags.maxRunning, "--max-running");
      const maxDepth = nonnegative(program, flags.maxDepth, "--max-depth");
      const crew = createSubagents({
        runtimes: { get: (id) => offered.find((runtime) => runtime.id === id) },
        ...(maxRunning === undefined ? {} : { maxRunning }),
        ...(maxDepth === undefined ? {} : { maxDepth }),
        ...(flags.cwd === undefined ? {} : { cwd: path.resolve(flags.cwd) }),
        ...(flags.logDir === undefined ? {} : { logDir: path.resolve(flags.logDir) }),
      });
      const stop = async (): Promise<void> => {
        await crew.close();
        process.exit(0);
      };
      // Children run in their own process groups; a stopped server takes them down first.
      process.once("SIGTERM", () => {
        void stop();
      });
      process.once("SIGINT", () => {
        void stop();
      });
      await serveMcp({ input: process.stdin, output: process.stdout, tools: subagentTools(crew, offered), crew, version });
      process.exit(0);
    });
}
