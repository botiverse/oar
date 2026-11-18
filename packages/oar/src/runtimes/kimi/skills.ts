/* oxlint-disable oxc/no-map-spread -- Preserve only native skill metadata in the public result. */
import type { InventoryReader, InventoryResult, SkillEntry } from "../../contracts/inventory.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { withQueryDeadline } from "../../shared/executable/query.js";
import { type JsonRecord } from "../../shared/json.js";
import { boolField, inventoryOk, unavailableInventory, named, nativeRows, skillScope, textField, unsupportedInventory, workspaceScope } from "../../shared/inventory.js";

import { kimiWebRequest } from "./web-query.js";
import { startKimiWeb } from "./web-startup.js";
import { stopKimiWeb } from "./web-shutdown.js";

function skills(payload: JsonRecord): SkillEntry[] {
  return nativeRows(payload.skills).map((skill) => ({
    name: named(skill), ...textField("description", skill.description),
    ...textField("path", skill.path), ...textField("source", skill.source),
    ...skillScope(skill.source, { builtin: "builtin", user: "user", project: "project", extra: "other" }),
    ...boolField("disableModelInvocation", skill.disable_model_invocation),
  }));
}

function workspaceId(workspace: JsonRecord): string {
  if (typeof workspace.id !== "string" || workspace.id.length === 0) { throw new TypeError("Kimi workspace has no identity"); }
  return workspace.id;
}

/** Native workspace catalog; no session, model prompt or authentication flow. */
// oxlint-disable-next-line require-await -- Keep option-validation errors and immediate unsupported results on the promise contract.
export const kimiSkills: InventoryReader<SkillEntry> = async (installation, options = {}) => {
  if (installation.via !== "executable") {
    return unsupportedInventory("installation_unsupported", "Kimi skill discovery requires an executable");
  }
  const scope = workspaceScope(options);
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) { throw new RangeError("timeoutMs must be positive and finite"); }
  return withQueryDeadline<InventoryResult<SkillEntry>>("Kimi skill discovery", timeoutMs, async signal => {
    try {
      const { child, web } = await startKimiWeb(installation.command, sessionEnvironment(options.env), signal, scope.cwd);
      try {
        const catalog = await kimiWebRequest(web, signal, "/workspaces");
        const existing = new Set(nativeRows(catalog.items).map((row) => workspaceId(row)));
        const id = workspaceId(await kimiWebRequest(web, signal, "/workspaces", "POST", { root: scope.cwd }));
        const path = `/workspaces/${encodeURIComponent(id)}`;
        try {
          const payload = await kimiWebRequest(web, signal, `${path}/skills`);
          return inventoryOk(scope, "discovered", skills(payload));
        } finally {
          // Only unregister the workspace this read created. Native logs/indexes
          // and the persistent server token remain; interruption can leave registration.
          if (!existing.has(id)) { await kimiWebRequest(web, signal, path, "DELETE"); }
        }
      } finally { await stopKimiWeb(child, web); }
    } catch {
      // Never expose native errors that could contain the private Web bearer.
      return unavailableInventory("query_failed", "Native inventory query failed");
    }
  }, unavailableInventory("timeout", "Native inventory query timed out"));
};
