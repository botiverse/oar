/* oxlint-disable oxc/no-map-spread -- Preserve only native skill metadata in the public result. */
import type { InventoryReader, SkillEntry } from "../../contracts/inventory.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { spawnLineProcess } from "../../shared/executable/index.js";
import { type JsonRecord } from "../../shared/json.js";
import { boolField, inventoryOk, inventoryRead, named, nativeRows, skillScope, textField, unsupportedInventory, workspaceScope } from "../../shared/inventory.js";

import { kimiWebEndpoint, kimiWebRequest } from "./web-query.js";

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
  const child = spawnLineProcess(installation.command, ["web", "--no-open", "--host", "127.0.0.1", "--port", "0"], {
    cwd: scope.cwd, env: sessionEnvironment(options.env), killTree: true, inheritStderr: false,
  });
  const ready = kimiWebEndpoint(child, controller.signal);
  // A spawn failure can occur before the readiness promise is awaited.
  // oxlint-disable-next-line promise/prefer-await-to-then -- Observe early rejection without blocking process startup.
  void ready.catch(() => {});
  try {
    return await inventoryRead(async () => {
      await child.spawned;
      const web = await ready;
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
    child.kill();
    await child.exited;
  }
};
