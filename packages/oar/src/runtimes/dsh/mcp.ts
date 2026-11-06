import { randomUUID } from "node:crypto";
import { UnsupportedOptionError } from "../../contracts/errors.js";
import type { McpServer } from "../../contracts/session.js";
import type { JsonRecord } from "../../shared/json.js";
import { checkMcpServerNames, hasMcpCredentials, isHttpMcpServer } from "../../shared/mcp-servers.js";

/** Native loader rows for this owned process only. No package import or change to the user's profile. */
export function dshMcpRows(servers: readonly McpServer[] | undefined, cwd: string): readonly JsonRecord[] {
  checkMcpServerNames(servers ?? []);
  return (servers ?? []).map((server) => {
    if (isHttpMcpServer(server) || hasMcpCredentials(server)) {
      throw new UnsupportedOptionError("mcpServers", "DSH session MCP supports stdio command and args only; HTTP, env and headers have no verified persistence boundary");
    }
    if (!/^[A-Za-z0-9_-]{1,32}$/u.test(server.name)) {
      throw new UnsupportedOptionError("mcpServers", "DSH MCP server names must match [A-Za-z0-9_-]{1,32}; OAR does not rename them");
    }
    return {
      id: `oar-mcp-${randomUUID()}`, name: "@deepseek-ai/dsh-mcp-client",
      config: { transport: "stdio", serverName: server.name, command: server.command, args: [...server.args ?? []], cwd, failOnStartupError: true },
    };
  });
}
