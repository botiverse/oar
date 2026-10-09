import type { McpServer } from "../../contracts/session.js";
import { UnsupportedOptionError } from "../../contracts/errors.js";
import { asRecord, type JsonRecord } from "../json.js";
import { checkMcpServerNames, givenMcpServers, isHttpMcpServer, mcpCredentialRedactor, redactError } from "../mcp-servers.js";

/*
 * SessionOptions.mcpServers on an ACP runtime: the `mcpServers` param of
 * `session/new`, `session/load` and `session/resume`, which ACP defines in
 * the same shape (stdio `{name, command, args, env: [{name, value}]}`, http
 * `{type: "http", name, url, headers: [{name, value}]}`). Given on every
 * open: no measured agent remembers them across a resume (runtime pages).
 * Every list is sent whole, `args`, `env` and `headers` included when empty,
 * because opencode 1.18.30 reads them unguarded.
 */

function pairs(values: Readonly<Record<string, string>> | undefined): readonly JsonRecord[] {
  return Object.entries(values ?? {}).map(([name, value]) => ({ name, value }));
}

/** One entry in ACP's `McpServer` shape. */
export function acpMcpServer(server: McpServer): JsonRecord {
  return isHttpMcpServer(server)
    ? { type: "http", name: server.name, url: server.url, headers: pairs(server.headers) }
    : { name: server.name, command: server.command, args: [...server.args ?? []], env: pairs(server.env) };
}

/**
 * The `mcpServers` param for an open, given the agent's `initialize` answer:
 * an http entry is refused (`UnsupportedOptionError` on `mcpServers`) unless
 * the agent declares `agentCapabilities.mcpCapabilities.http`, which ACP
 * requires before a client sends one. Stdio needs no capability.
 */
export function acpMcpServersParam(servers: readonly McpServer[] | undefined, initialized: JsonRecord): readonly JsonRecord[] {
  const given = givenMcpServers(servers);
  if (given === null) {
    return [];
  }
  const http = given.find((server) => isHttpMcpServer(server));
  const capabilities = asRecord(asRecord(initialized.agentCapabilities)?.mcpCapabilities);
  if (http !== undefined && capabilities?.http !== true) {
    throw new UnsupportedOptionError("mcpServers", `the agent's initialize declares no mcpCapabilities.http, so it attaches no http MCP server (${JSON.stringify(http.name)})`);
  }
  return given.map((server) => acpMcpServer(server));
}

/**
 * For an open given these entries: throws now, before the agent starts, on
 * an empty or repeated name, and returns what a failed open's error becomes:
 * the same error without the credentials the entries carry.
 */
export function acpMcpOpenGuard(servers: readonly McpServer[] | undefined, redact = mcpCredentialRedactor(servers)): (error: unknown) => unknown {
  checkMcpServerNames(servers ?? []);
  return (error) => redactError(error, redact);
}
