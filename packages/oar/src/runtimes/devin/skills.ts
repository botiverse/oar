/* oxlint-disable oxc/no-map-spread -- Project only native skill metadata. */
import type { InventoryReader, SkillEntry } from "../../contracts/inventory.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { spawnLineProcess } from "../../shared/executable/index.js";
import { parseJson, type JsonRecord } from "../../shared/json.js";
import { inventoryOk, inventoryRead, named, nativeRows, skillScope, textField, unsupportedInventory, workspaceScope } from "../../shared/inventory.js";

function strings(value: unknown): readonly string[] | undefined {
  if (value === undefined) { return undefined; }
  if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === "string")) {
    throw new TypeError("Invalid Devin skill metadata list");
  }
  return value;
}
function project(row: JsonRecord): SkillEntry {
  const triggers = strings(row.triggers);
  strings(row.warnings);
  strings(row.errors);
  return {
    name: named(row), ...textField("description", row.description),
    ...textField("source", row.provider), ...skillScope(row.provider, { Builtin: "builtin" }),
    ...(row.base_dir === "" ? {} : textField("path", row.base_dir)),
    ...(triggers === undefined ? {} : { disableModelInvocation: !triggers.includes("model"), userInvocable: triggers.includes("user") }),
  };
}
/** Native CLI catalog, including bundled skills; no session or model request. */
export const devinSkills: InventoryReader<SkillEntry> = async (installation, options = {}) => {
  if (installation.via !== "executable") {
    return unsupportedInventory("installation_unsupported", "Devin skill discovery requires an executable");
  }
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) { throw new RangeError("timeoutMs must be positive and finite"); }
  const scope = workspaceScope(options);
  const child = spawnLineProcess(installation.command, ["skills", "list", "--json"], {
    cwd: scope.cwd, env: sessionEnvironment(options.env), killTree: true, inheritStderr: false,
  });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
  try {
    return await inventoryRead(async () => {
      await child.spawned;
      const code = await child.exited;
      if (code !== 0) { throw new Error("Devin skill query failed"); }
      const rows = nativeRows(parseJson(stdout));
      const items = rows.map(row => project(row));
      return inventoryOk(scope, "discovered", items, rows.some(row => (strings(row.errors)?.length ?? 0) > 0));
    }, timeoutMs);
  } finally {
    child.kill();
    await child.exited;
  }
};
