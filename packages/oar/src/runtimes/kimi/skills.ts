/* oxlint-disable oxc/no-map-spread -- Preserve only native skill metadata in the public result. */
import type { InventoryReader, SkillEntry } from "../../contracts/inventory.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { type LineProcess } from "../../shared/executable/index.js";
import { type JsonRecord } from "../../shared/json.js";
import { boolField, inventoryOk, inventoryRead, named, nativeRows, skillScope, textField, unsupportedInventory, workspaceScope } from "../../shared/inventory.js";

import { kimiWebRequest } from "./web-query.js";
import { startKimiWeb } from "./web-startup.js";

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
export const kimiSkills: InventoryReader<SkillEntry> = async (installation, options = {}) => {
  if (installation.via !== "executable") {
    return unsupportedInventory("installation_unsupported", "Kimi skill discovery requires an executable");
  }
  const scope = workspaceScope(options);
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) { throw new RangeError("timeoutMs must be positive and finite"); }
  const controller = new AbortController();
  const state: { child?: LineProcess; starting?: ReturnType<typeof startKimiWeb> } = {};
  try {
    return await inventoryRead(async () => {
      state.starting = startKimiWeb(installation.command, sessionEnvironment(options.env), controller.signal, scope.cwd);
      const started = await state.starting;
      state.child = started.child;
      const web = started.web;
      const catalog = await kimiWebRequest(web, controller.signal, "/workspaces");
      const existing = new Set(nativeRows(catalog.items).map((row) => workspaceId(row)));
      const id = workspaceId(await kimiWebRequest(web, controller.signal, "/workspaces", "POST", { root: scope.cwd }));
      const path = `/workspaces/${encodeURIComponent(id)}`;
      try {
        const payload = await kimiWebRequest(web, controller.signal, `${path}/skills`);
        return inventoryOk(scope, "discovered", skills(payload));
      } finally {
        // Only unregister the workspace this read created. Native logs/indexes
        // and the persistent server token remain; interruption can leave registration.
        if (!existing.has(id)) { await kimiWebRequest(web, controller.signal, path, "DELETE"); }
      }
    }, timeoutMs);
  } finally {
    controller.abort();
    // Inventory reads retain their existing joined-startup cleanup contract.
    await state.starting?.catch(() => {});
    if (state.child !== undefined && !state.child.stopping()) { state.child.kill(); }
    if (state.child !== undefined) { await state.child.exited; }
  }
};
