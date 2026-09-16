/* oxlint-disable oxc/no-map-spread -- Project immutable native entries into credential-free records. */
import type { InventoryReader, InventoryResult, McpServerEntry, SkillEntry } from "../../contracts/inventory.js";
import { spawnLineProcess } from "../../shared/executable/index.js";
import { asRecord, parseJson, type JsonRecord } from "../../shared/json.js";
import { inventoryOk, inventoryRead, named, nativeRows, textField, unsupportedInventory, workspaceScope } from "../../shared/inventory.js";

export function projectGrokSkills(payload: JsonRecord): SkillEntry[] {
  return nativeRows(payload.skills).map((skill) => ({
    name: named(skill), ...textField("description", skill.description),
    ...textField("source", skill.source),
  }));
}
export function projectGrokServers(payload: JsonRecord): McpServerEntry[] {
  return nativeRows(payload.mcpServers).map((server) => ({
    id: named(server), name: named(server), ...textField("source", server.source),
  }));
}
/** inspect is cwd-scoped discovery including compatibility entries, not live connections. */
function reader<T>(project: (payload: JsonRecord) => T[]): InventoryReader<T> {
  return async (installation, options = {}): Promise<InventoryResult<T>> => {
    if (installation.via !== "executable") {
      return unsupportedInventory("installation_unsupported", "Grok inventory requires an executable");
    }
    const scope = workspaceScope(options);
    const child = spawnLineProcess(installation.command, ["inspect", "--json"], { cwd: scope.cwd });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
    try {
      return await inventoryRead(async () => {
        await child.spawned;
        const code = await child.exited;
        if (code !== 0) {
          throw new Error("Grok inspect failed");
        }
        const payload = asRecord(parseJson(stdout));
        if (payload === null) {
          throw new TypeError("Invalid Grok inspect result");
        }
        return inventoryOk(scope, "discovered", project(payload));
      }, options.timeoutMs);
    } finally {
      child.kill();
      await child.exited;
    }
  };
}
export const grokSkills = reader(projectGrokSkills);
export const grokMcpServers = reader(projectGrokServers);
