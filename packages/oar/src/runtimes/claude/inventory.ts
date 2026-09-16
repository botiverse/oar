/* oxlint-disable oxc/no-map-spread -- Project immutable native entries into credential-free records. */
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { InventoryReader, InventoryResult, InventoryScope, McpServerEntry, SkillEntry, ToolEntry } from "../../contracts/inventory.js";
import { spawnLineProcess } from "../../shared/executable/index.js";
import { asRecord, parseJson, type JsonRecord } from "../../shared/json.js";
import { inventoryOk, inventoryRead, named, nativeRows, textField, unsupportedInventory, workspaceScope, type NativeInventoryRequest } from "../../shared/inventory.js";

export function projectClaudeSkills(payload: JsonRecord): SkillEntry[] {
  return nativeRows(asRecord(payload.skills)?.skillFrontmatter).map((skill) => ({
    name: named(skill), ...textField("source", skill.source),
  }));
}
export function projectClaudeServers(servers: readonly JsonRecord[]): McpServerEntry[] {
  return servers.map((server) => ({
    id: named(server), name: named(server),
    ...textField("status", server.status), ...textField("source", server.scope),
    ...(Array.isArray(server.tools) ? { toolCount: server.tools.length } : {}),
    ...((server.error === null || server.error === undefined) ? {} : { error: "Native MCP connection failed" }),
  }));
}
export function projectClaudeTools(servers: readonly JsonRecord[]): ToolEntry[] {
  return servers.flatMap((server) => server.tools === undefined ? [] : nativeRows(server.tools).map((tool) => ({
    name: named(tool), mcpServerId: named(server), source: "mcp",
    ...textField("description", tool.description),
  })));
}
class UnsupportedControlError extends Error {
  override name = "UnsupportedControlError";
}
function reader<T>(read: (request: NativeInventoryRequest, scope: InventoryScope) => Promise<InventoryResult<T>>): InventoryReader<T> {
  return async (installation, options = {}) => {
    if (installation.via !== "executable") {
      return unsupportedInventory("installation_unsupported", "Claude inventory requires an executable");
    }
    const scope = workspaceScope(options);
    const child = spawnLineProcess(installation.command, [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
    ], { cwd: scope.cwd, env: { ...process.env, CLAUDECODE: undefined } });
    let pending: { id: string; resolve(value: JsonRecord): void; reject(error: Error): void } | null = null;
    let closed = false;
    child.onLine((line) => {
      const message = asRecord(parseJson(line));
      const response = asRecord(message?.response);
      if (message?.type === "control_response" && response !== null && response.request_id === pending?.id && pending !== null) {
        const waiter = pending;
        pending = null;
        if (response.subtype === "success") {
          waiter.resolve(asRecord(response.response) ?? {});
        } else if (typeof response.error === "string" && /unsupported|not supported|unknown control/iu.test(response.error)) {
          waiter.reject(new UnsupportedControlError());
        } else {
          waiter.reject(new Error("Native control query failed"));
        }
      }
    });
    child.onExit(() => {
      closed = true;
      pending?.reject(new Error("Native process exited"));
      pending = null;
    });
    const request: NativeInventoryRequest = async (method, params) => {
      if (closed) {
        throw new Error("Native process exited");
      }
      const id = randomUUID();
      const { promise, resolve, reject } = Promise.withResolvers<JsonRecord>();
      pending = { id, resolve, reject };
      child.write(`${JSON.stringify({ type: "control_request", request_id: id, request: { subtype: method, ...params } })  }\n`);
      const result = await promise;
      return result;
    };
    try {
      return await inventoryRead(async () => {
        try {
          await child.spawned;
          await request("initialize", {});
          return await read(request, scope);
        } catch (error) {
          if (error instanceof UnsupportedControlError) {
            return unsupportedInventory("native_query_unavailable", "This Claude build does not expose the inventory query");
          }
          throw error;
        }
      }, options.timeoutMs);
    } finally {
      child.kill();
      await child.exited;
    }
  };
}
async function readServers(request: NativeInventoryRequest): Promise<JsonRecord[]> {
  let payload = await request("mcp_status", {});
  let servers = nativeRows(payload.mcpServers);
  // Bounded startup wait; pending is returned as partial rather than hidden.
  for (let attempt = 0; attempt < 10 && servers.some((server) => server.status === "pending"); attempt += 1) {
    await delay(200);
    payload = await request("mcp_status", {});
    servers = nativeRows(payload.mcpServers);
  }
  return servers;
}
function partial(servers: readonly JsonRecord[]): boolean {
  return servers.some((server) => server.status === "pending" || server.status === "failed");
}
export const claudeSkills = reader(async (request, scope) => {
  const payload = await request("get_context_usage", { detail: "summary" });
  return inventoryOk(scope, "context", projectClaudeSkills(payload));
});
export const claudeMcpServers = reader(async (request, scope) => {
  const servers = await readServers(request);
  return inventoryOk(scope, "discovered", projectClaudeServers(servers), partial(servers));
});
export const claudeTools = reader(async (request, scope) => {
  const servers = await readServers(request);
  return inventoryOk(scope, "mcp-only", projectClaudeTools(servers), partial(servers));
});
