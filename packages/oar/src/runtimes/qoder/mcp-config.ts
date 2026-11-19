import type { McpServer } from "../../contracts/session.js";
import { handOverMcpConfigFile, sweepAbandonedMcpConfigDirs, type McpConfigHandoff } from "../../shared/mcp-config-handoff.js";
import { checkMcpServerNames, isHttpMcpServer } from "../../shared/mcp-servers.js";

/*
 * SessionOptions.mcpServers reach Qoder as `--mcp-config <path>`: a path,
 * never inline JSON on argv, because `env` and `headers` values are
 * credentials. On POSIX the path is a 0600 FIFO removed as soon as Qoder reads
 * it; on Windows (where FIFOs are unavailable) it is a 0600 file removed as
 * soon as `initialize` finishes (and at the latest on process exit).
 *
 * Verified on Qoder 1.1.78 (Linux x64) and exercised on CI's Qoder 1.1.81
 * daemon across Linux, macOS and Windows: Qoder reads the config once during
 * startup, blocks for a late FIFO writer, keeps stdio and HTTP server
 * configurations in memory after the path is gone, and writes no MCP
 * credentials to its home directory.
 */

export type { McpConfigHandoff } from "../../shared/mcp-config-handoff.js";

/** Qoder's `--mcp-config` document: stdio `{type, command, args, env}`, http `{type, url, headers}`. */
export function qoderMcpConfig(servers: readonly McpServer[]): { readonly mcpServers: Record<string, unknown> } {
  return {
    mcpServers: Object.fromEntries(servers.map((server) => [server.name, isHttpMcpServer(server)
      ? { type: "http", url: server.url, ...(server.headers === undefined ? {} : { headers: server.headers }) }
      : { type: "stdio", command: server.command, args: server.args ?? [], ...(server.env === undefined ? {} : { env: server.env }) }])),
  };
}

export const QODER_MCP_PREFIX = "oar-qoder-mcp-";

/** Sweep directories dead hosts left behind before launching Qoder. */
export async function sweepAbandonedQoderMcpConfigs(): Promise<void> {
  await sweepAbandonedMcpConfigDirs(QODER_MCP_PREFIX);
}

/** Private handoff for Qoder's session MCP servers. Rejects invalid names before creating anything. */
export async function handOverQoderMcpConfig(servers: readonly McpServer[]): Promise<McpConfigHandoff> {
  checkMcpServerNames(servers);
  const handoff = await handOverMcpConfigFile(QODER_MCP_PREFIX, JSON.stringify(qoderMcpConfig(servers)));
  return handoff;
}
