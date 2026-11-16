/* oxlint-disable oxc/no-map-spread -- Preserve only native skill metadata in the public result. */
import type { InventoryReader, SkillEntry } from "../../contracts/inventory.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { spawnLineProcess, type LineProcess } from "../../shared/executable/index.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { boolField, inventoryOk, inventoryRead, named, nativeRows, skillScope, textField, unsupportedInventory, workspaceScope } from "../../shared/inventory.js";

interface WebEndpoint { readonly origin: string; readonly token: string }

/** The banner is private: never forward native stdout/stderr or its bearer token. */
async function endpoint(child: LineProcess, signal: AbortSignal): Promise<WebEndpoint> {
  const { promise, resolve, reject } = Promise.withResolvers<WebEndpoint>();
  {
    signal.addEventListener("abort", () => { reject(new Error("Kimi discovery stopped")); }, { once: true });
    child.onExit(() => { reject(new Error("Kimi discovery exited")); });
    child.onLine((line) => {
      // oxlint-disable-next-line no-control-regex -- Stop at a native ANSI color escape without retaining the token.
      const match = /http:\/\/127\.0\.0\.1:([0-9]+)\/?#token=([^\s\u001B]+)/u.exec(line);
      if (match?.[1] !== undefined && match[2] !== undefined && Number(match[1]) > 0 && Number(match[1]) <= 65_535) {
        resolve({ origin: `http://127.0.0.1:${match[1]}`, token: match[2] });
      }
    });
  }
  const value = await promise;
  return value;
}

async function request(web: WebEndpoint, signal: AbortSignal, path: string, method = "GET", body?: JsonRecord): Promise<JsonRecord> {
  const response = await fetch(`${web.origin}/api/v1${path}`, {
    method, signal, redirect: "error",
    headers: { Authorization: `Bearer ${web.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) { throw new Error("Kimi discovery HTTP failure"); }
  const envelope = asRecord(await response.json());
  const data = asRecord(envelope?.data);
  if (envelope?.code !== 0 || data === null) { throw new Error("Kimi discovery query failed"); }
  return data;
}

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
  const ready = endpoint(child, controller.signal);
  // A spawn failure can occur before the readiness promise is awaited.
  // oxlint-disable-next-line promise/prefer-await-to-then -- Observe early rejection without blocking process startup.
  void ready.catch(() => {});
  try {
    return await inventoryRead(async () => {
      await child.spawned;
      const web = await ready;
      const catalog = await request(web, controller.signal, "/workspaces");
      const existing = new Set(nativeRows(catalog.items).map((row) => workspaceId(row)));
      const id = workspaceId(await request(web, controller.signal, "/workspaces", "POST", { root: scope.cwd }));
      const path = `/workspaces/${encodeURIComponent(id)}`;
      try {
        const payload = await request(web, controller.signal, `${path}/skills`);
        return inventoryOk(scope, "discovered", skills(payload));
      } finally {
        // Only unregister the workspace this read created. Native logs/indexes
        // and the persistent server token remain; interruption can leave registration.
        if (!existing.has(id)) { await request(web, controller.signal, path, "DELETE"); }
      }
    }, timeoutMs);
  } finally {
    controller.abort();
    child.kill();
    await child.exited;
  }
};
