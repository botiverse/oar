import { rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpServer, SessionOptions } from "../../contracts/session.js";
import { spawnLineProcess, type LineProcess } from "../../shared/executable/index.js";
import { checkMcpServerNames, givenMcpServers, isHttpMcpServer } from "../../shared/mcp-servers.js";

/*
 * Starting the claude process for one session: SessionOptions as flags.
 *
 * SessionOptions.mcpServers is `--mcp-config <file>` (claude 2.1.292, probed
 * against a scripted provider). The servers join the user's own, which stay
 * loaded because oar never passes `--strict-mcp-config`; claude reports them
 * in system/init as `source: "dynamic"`, and a dynamic server replaces a
 * user-scope server of the same name for that process (the user's other
 * servers stay). The same flag goes on a `--resume`, which remembers none.
 * A file, not inline JSON on the command line: argv is readable by every
 * user on the machine (`ps`), and `env` / `headers` values are credentials.
 * The file sits in its own fresh directory (0700), is written 0600, and is
 * deleted when the claude process ends, however it ends.
 */

/** The process a claude session drives. */
export type ClaudeProcess = LineProcess;

/** claude's `--mcp-config` document for the entries: stdio `{type, command, args, env}`, http `{type, url, headers}`. */
export function claudeMcpConfig(servers: readonly McpServer[]): { readonly mcpServers: Record<string, unknown> } {
  return {
    mcpServers: Object.fromEntries(servers.map((server) => [server.name, isHttpMcpServer(server)
      ? { type: "http", url: server.url, ...(server.headers === undefined ? {} : { headers: server.headers }) }
      : { type: "stdio", command: server.command, args: server.args ?? [], ...(server.env === undefined ? {} : { env: server.env }) }])),
  };
}

/** The entries' config in a 0600 file in a fresh temporary directory, and how to delete both (synchronously, so an exit handler finishes before `exited` resolves). */
async function writeMcpConfig(servers: readonly McpServer[]): Promise<{ readonly path: string; remove(): void }> {
  checkMcpServerNames(servers);
  const directory = await mkdtemp(path.join(tmpdir(), "oar-claude-mcp-"));
  const file = path.join(directory, "mcp.json");
  const remove = (): void => {
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    await writeFile(file, JSON.stringify(claudeMcpConfig(servers)), { mode: 0o600, flag: "wx" });
  } catch (error) {
    remove();
    throw error;
  }
  return { path: file, remove };
}

function spawnClaude(command: string, sessionId: string, options: SessionOptions, mcpConfig: string | null): LineProcess {
  return spawnLineProcess(command, [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose", "--replay-user-messages",
    // YOLO by default (repo policy, 2026-08-24): in embedded/SDK use there is
    // no human at an approval prompt: a permission gate is a hang, not
    // safety. Isolation is the sandbox's job, not the approval flow's.
    "--dangerously-skip-permissions",
    ...(options.resume === undefined ? ["--session-id", sessionId] : ["--resume", sessionId]),
    ...(options.model === undefined ? [] : ["--model", options.model]),
    ...(options.effort === undefined ? [] : ["--effort", options.effort]),
    ...(options.systemPrompt === undefined ? [] : ["--system-prompt", options.systemPrompt]),
    ...(options.appendSystemPrompt === undefined ? [] : ["--append-system-prompt", options.appendSystemPrompt]),
    ...(mcpConfig === null ? [] : ["--mcp-config", mcpConfig]),
  ], {
    cwd: options.cwd,
    env: { ...process.env, CLAUDECODE: undefined, ...options.env },
  });
}

/**
 * Start claude for a session (`--session-id`, or `--resume` an existing one)
 * and wait until it runs; with MCP servers, their config file lives exactly
 * as long as the process. Rejects on a list with an empty or repeated name
 * before anything starts, and when claude cannot be spawned.
 */
export async function launchClaude(command: string, sessionId: string, options: SessionOptions): Promise<ClaudeProcess> {
  const servers = givenMcpServers(options.mcpServers);
  const mcpConfig = servers === null ? null : await writeMcpConfig(servers);
  let child: LineProcess | null = null;
  try {
    child = spawnClaude(command, sessionId, options, mcpConfig?.path ?? null);
  } finally {
    if (child === null) {
      mcpConfig?.remove();
    }
  }
  if (mcpConfig !== null) {
    // Fires once, for an exit or a failed spawn alike, before `exited` resolves.
    child.onExit(() => {
      mcpConfig.remove();
    });
  }
  await child.spawned;
  return child;
}
