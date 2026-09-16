/* oxlint-disable oxc/no-map-spread -- Project immutable native entries into credential-free records. */
import type { InventoryResult, InventoryReader, InventoryScope, McpServerEntry, SkillEntry, ToolEntry } from "../../contracts/inventory.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { boolField, inventoryOk, inventoryRead, named, nativeRows, textField, unsupportedInventory, workspaceScope, type NativeInventoryRequest } from "../../shared/inventory.js";
import { startAppServerClient } from "./app-server-client.js";

export function projectCodexSkills(payload: JsonRecord): SkillEntry[] {
  return nativeRows(payload.data).flatMap((entry) => nativeRows(entry.skills).map((skill) => ({
    name: named(skill),
    ...textField("description", skill.description),
    ...textField("path", skill.path),
    ...textField("source", skill.scope),
    ...boolField("enabled", skill.enabled),
  })));
}
export function projectCodexServers(servers: readonly JsonRecord[]): McpServerEntry[] {
  return servers.map((server) => ({
    id: named(server), name: named(server),
    ...textField("status", server.runtimeStatus),
    ...textField("authStatus", server.authStatus),
    ...(asRecord(server.tools) === null ? {} : { toolCount: Object.keys(asRecord(server.tools) ?? {}).length }),
    ...((server.toolsError === null || server.toolsError === undefined) ? {} : { error: "Native tool discovery failed" }),
  }));
}
export function projectCodexTools(servers: readonly JsonRecord[]): ToolEntry[] {
  return servers.flatMap((server) => Object.values(asRecord(server.tools) ?? {}).map((value) => {
    const tool = asRecord(value) ?? {};
    const schema = asRecord(tool.inputSchema);
    return { name: named(tool), mcpServerId: named(server), source: "mcp",
      ...textField("description", tool.description),
      ...(schema === null ? {} : { inputSchema: schema }) };
  }));
}
async function serversOf(request: NativeInventoryRequest): Promise<JsonRecord[]> {
  const servers: JsonRecord[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  while (seen.size <= 100) {
    const page = await request("mcpServerStatus/list", { detail: "full", limit: 100, cursor });
    servers.push(...nativeRows(page.data));
    if (page.nextCursor === null) {
      return servers;
    }
    if (typeof page.nextCursor !== "string" || seen.has(page.nextCursor) || seen.size >= 100) {
      throw new Error("Invalid MCP pagination");
    }
    cursor = page.nextCursor;
    seen.add(cursor);
  }
  throw new Error("MCP pagination exceeded limit");
}
export async function readCodexSkills(request: NativeInventoryRequest, scope: InventoryScope, cwd: string): Promise<InventoryResult<SkillEntry>> {
  const result = await request("skills/list", { cwds: [cwd] });
  const partial = nativeRows(result.data).some((entry) => Array.isArray(entry.errors) && entry.errors.length > 0);
  return inventoryOk(scope, "discovered", projectCodexSkills(result), partial);
}
function reader<T>(read: (request: NativeInventoryRequest, scope: InventoryScope, cwd: string) => Promise<InventoryResult<T>>): InventoryReader<T> {
  return async (installation, options = {}) => {
    if (installation.via !== "executable") {
      return unsupportedInventory("installation_unsupported", "Codex inventory requires an executable");
    }
    const scope = workspaceScope(options);
    const client = startAppServerClient(installation.command, undefined, {}, scope.cwd);
    client.handle({ onNotification: () => {}, onServerRequest: () => {} });
    try {
      return await inventoryRead(async () => {
        await client.spawned;
        await client.request("initialize", { clientInfo: { name: "oar-inventory", version: "0.0.0" }, capabilities: { experimentalApi: true } });
        client.notify("initialized", {});
        return read(async (method, params) => {
          const result = await client.request(method, params);
          return result;
        }, scope, scope.cwd);
      }, options.timeoutMs);
    } finally {
      client.kill();
      await client.exited;
    }
  };
}
export const codexSkills = reader(readCodexSkills);
export const codexMcpServers = reader(async (request, scope) => {
  const servers = await serversOf(request);
  return inventoryOk(scope, "discovered", projectCodexServers(servers), servers.some((server) => (server.toolsError !== null && server.toolsError !== undefined)));
});
export const codexTools = reader(async (request, scope) => {
  const servers = await serversOf(request);
  return inventoryOk(scope, "mcp-only", projectCodexTools(servers), servers.some((server) => (server.toolsError !== null && server.toolsError !== undefined)));
});
