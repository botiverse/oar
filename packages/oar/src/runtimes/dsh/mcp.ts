import { UnsupportedOptionError } from "../../contracts/errors.js";
import type { McpServer } from "../../contracts/session.js";
import type { JsonRecord } from "../../shared/json.js";
import { checkMcpServerNames, isHttpMcpServer } from "../../shared/mcp-servers.js";

/** Native MCP plugin configurations sent through the session bridge stdin. */
export function dshMcpConfigs(servers: readonly McpServer[] | undefined, cwd: string): readonly JsonRecord[] {
  checkMcpServerNames(servers ?? []);
  return (servers ?? []).map((server) => {
    if (!/^[A-Za-z0-9_-]{1,32}$/u.test(server.name)) {
      throw new UnsupportedOptionError("mcpServers", "DSH MCP server names must match [A-Za-z0-9_-]{1,32}; OAR does not rename them");
    }
    return isHttpMcpServer(server)
      ? { serverName: server.name, failOnStartupError: true, transport: "streamable-http", url: server.url, headers: server.headers ?? {} }
      : { serverName: server.name, failOnStartupError: true, transport: "stdio", command: server.command, args: [...server.args ?? []], env: server.env ?? {}, cwd };
  });
}
