import type { McpServer } from "../../contracts/session.js";
import { handOverMcpConfigFile, sweepAbandonedMcpConfigDirs, type McpConfigHandoff } from "../../shared/mcp-config-handoff.js";
import { checkMcpServerNames, isHttpMcpServer } from "../../shared/mcp-servers.js";

/*
 * SessionOptions.mcpServers reach claude as `--mcp-config <path>`: a path,
 * never inline JSON on argv, which every user on the machine can read
 * (`ps`), because `env` and `headers` values are credentials.
 *
 * On POSIX the path is a 0600 FIFO removed as soon as claude reads it; where
 * FIFOs are unavailable (Windows, or no `mkfifo`) it is a 0600 file removed
 * when claude exits. claude 2.1.292 opens the path once at startup, waits for
 * the writer when it gets there first, and keeps the config in memory: a stdio
 * server it restarts and an http server it initializes again after a 404 both
 * get their credentials with the path gone.
 * sea-trial/vendor/claude-mcp-config.vendor.test.ts checks this on every
 * claude CI installs.
 */

export type { McpConfigHandoff } from "../../shared/mcp-config-handoff.js";

/** claude's `--mcp-config` document for the entries: stdio `{type, command, args, env}`, http `{type, url, headers}`. */
export function claudeMcpConfig(servers: readonly McpServer[]): { readonly mcpServers: Record<string, unknown> } {
  return {
    mcpServers: Object.fromEntries(servers.map((server) => [server.name, isHttpMcpServer(server)
      ? { type: "http", url: server.url, ...(server.headers === undefined ? {} : { headers: server.headers }) }
      : { type: "stdio", command: server.command, args: server.args ?? [], ...(server.env === undefined ? {} : { env: server.env }) }])),
  };
}

const PREFIX = "oar-claude-mcp-";

/**
 * Before any claude starts, with servers or without: remove what hosts that
 * died left behind, letting a claude still waiting on such a FIFO go.
 */
export async function sweepAbandonedMcpConfigs(): Promise<void> {
  await sweepAbandonedMcpConfigDirs(PREFIX);
}

/** The handoff for these entries (sweeping as above first). Rejects on an empty or repeated name before anything is created. */
export async function handOverMcpConfig(servers: readonly McpServer[]): Promise<McpConfigHandoff> {
  checkMcpServerNames(servers);
  const handoff = await handOverMcpConfigFile(PREFIX, JSON.stringify(claudeMcpConfig(servers)));
  return handoff;
}
