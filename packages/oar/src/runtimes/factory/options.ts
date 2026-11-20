import type { RefusedSessionOptions } from "../../contracts/runtime.js";
import type { McpServer } from "../../contracts/session-options.js";
import { checkManagedLaunchArgs } from "../../shared/launch-args.js";
import { isHttpMcpServer } from "../../shared/mcp-servers.js";
import type { JsonRecord } from "../../shared/json.js";

export const factoryRefusedSessionOptions: RefusedSessionOptions = {
  modelRequests: "This adapter has no verified capture of the root agent's provider request",
  fork: "OAR has not verified a native droid fork that opens a copy of a saved session under a new id, cut after a chosen turn",
  goals: "This runtime interface exposes no structured native goal controls",
  endTurnProcessesOnAbort: "OAR has not verified reading and ending one aborted droid turn's processes while its session stays usable",
  serviceTier: "droid has no service-tier option",
  outputSchema: "droid's structuredOutputFormat has not been verified across turns yet",
  userConfiguration: "droid has no verified way to exclude user configuration while keeping its login and history",
  name: "droid's session title persistence has not been verified",
  additionalDirectories: "droid has no additional workspace directory option",
  disallowedTools: "droid's tool deny list (disabledToolIds) has not been verified against OAR's tool names",
  nativeMemoryDefault: "Factory droid exposes no verified below-user default layer for background auto-memory",
};

const FACTORY_MANAGED_LAUNCH_ARGS = new Set(["--input-format", "--output-format", "-o", "--session-id", "-s", "--fork", "--cwd", "-f", "--file", "--"]);

/** The protocol and session identity belong to OAR: launchArgs must not change them. */
export function checkFactoryLaunchArgs(args: readonly string[] | undefined): void {
  checkManagedLaunchArgs(args, FACTORY_MANAGED_LAUNCH_ARGS, (flag) => `Factory launchArgs cannot override ${flag}; OAR owns the protocol and session identity`);
}

/** OAR's MCP server shape as `initialize_session` / `load_session` take it (stdio `env` is a record, http `headers` a list). */
export function factoryMcpServers(servers: readonly McpServer[]): JsonRecord[] {
  return servers.map((server): JsonRecord => isHttpMcpServer(server)
    ? { type: "http", name: server.name, url: server.url, headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })) }
    : { name: server.name, command: server.command, args: [...(server.args ?? [])], env: { ...server.env } });
}
