/* oxlint-disable oxc/no-map-spread -- Project only native skill metadata. */
import type { InventoryReader, SkillEntry } from "../../contracts/inventory.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { boolField, inventoryOk, inventoryRead, named, nativeRows, skillScope, textField, unsupportedInventory, workspaceScope } from "../../shared/inventory.js";
import { startDroidClient } from "./client.js";

function project(row: JsonRecord): SkillEntry {
  return {
    name: named(row), ...textField("description", row.description),
    ...textField("path", row.filePath), ...textField("source", row.location),
    ...skillScope(row.location, { personal: "user", project: "project", builtin: "builtin", automation: "other" }),
    ...textField("plugin", row.pluginId), ...boolField("enabled", row.enabled),
    ...boolField("userInvocable", row.userInvocable),
  };
}

/** Native metadata query before session initialization; startup can still access the network. */
export const factorySkills: InventoryReader<SkillEntry> = async (installation, options = {}) => {
  if (installation.via !== "executable") {
    return unsupportedInventory("installation_unsupported", "Factory skill discovery requires an executable");
  }
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) { throw new RangeError("timeoutMs must be positive and finite"); }
  const scope = workspaceScope(options);
  const client = startDroidClient(installation.command, { cwd: scope.cwd, env: sessionEnvironment(options.env) });
  client.handle({ onNotification: () => {}, onUnmatched: () => {}, onServerRequest: (message) => {
    client.respond(message.id, { error: { code: -32_601, message: "Inventory query does not handle requests" } });
  } });
  try {
    return await inventoryRead(async () => {
      let result: JsonRecord = {};
      try { result = await client.request("droid.list_skills", { includeContent: false }); }
      catch (error) {
        if (error instanceof Error && asRecord(asRecord(error.cause)?.native)?.code === -32_601) {
          return unsupportedInventory("native_query_unavailable", "Factory does not expose a native skill query");
        }
        throw error;
      }
      if (result.projectAvailable !== undefined && typeof result.projectAvailable !== "boolean") {
        throw new TypeError("Invalid Factory project availability");
      }
      return inventoryOk(scope, "discovered", nativeRows(result.skills).map(row => project(row)), result.projectAvailable === false);
    }, timeoutMs);
  } finally { client.kill(); await client.exited; }
};
