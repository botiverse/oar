/* oxlint-disable oxc/no-map-spread -- Project only native metadata, never skill bodies or plugin errors. */
import { randomBytes } from "node:crypto";
import type { InventoryReader, SkillEntry } from "../../contracts/inventory.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { spawnLineProcess, type LineProcess } from "../../shared/executable/index.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { boolField, inventoryOk, inventoryRead, named, nativeRows, textField, unsupportedInventory, workspaceScope } from "../../shared/inventory.js";
import { serveEnvironment } from "./provider-auth-server.js";
import { legacySkills } from "./skills-v1.js";
import { opencodeRelease, type OpencodeRelease } from "./version.js";
import { opencodeSkillScopes } from "./skill-scope.js";

function projectSkills(value: unknown, major: 1 | 2): SkillEntry[] {
  return nativeRows(value).map((skill) => {
    const path = major === 1 ? skill.location : skill.path;
    if (typeof path !== "string" || path.length === 0) { throw new TypeError("OpenCode skill has no path"); }
    return {
      name: named(skill), ...textField("description", skill.description),
      ...(path === "<built-in>" ? { source: "builtin" } : { path }),
      ...boolField("disableModelInvocation", typeof skill.autoinvoke === "boolean" ? !skill.autoinvoke : undefined),
    };
  });
}

async function endpoint(child: LineProcess, signal: AbortSignal): Promise<string> {
  const ready = Promise.withResolvers<string>();
  signal.addEventListener("abort", () => { ready.reject(new Error("OpenCode discovery stopped")); }, { once: true });
  child.onExit(() => { ready.reject(new Error("OpenCode discovery exited")); });
  child.onLine((line) => {
    const match = /^server listening on http:\/\/127\.0\.0\.1:([0-9]+)\/?$/u.exec(line);
    const port = Number(match?.[1]);
    if (Number.isInteger(port) && port > 0 && port <= 65_535) { ready.resolve(`http://127.0.0.1:${String(port)}`); }
  });
  const value = await ready.promise;
  return value;
}

async function query(origin: string, password: string, cwd: string, signal: AbortSignal, path: string): Promise<JsonRecord[]> {
  const response = await fetch(`${origin}${path}`, {
    signal, redirect: "error", headers: {
      authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
      "x-opencode-directory": encodeURIComponent(cwd),
    },
  });
  if (!response.ok) { throw new Error("OpenCode discovery HTTP failure"); }
  const envelope = asRecord(await response.json());
  return nativeRows(envelope?.data);
}

function pluginFailed(plugin: JsonRecord): boolean {
  const status = asRecord(plugin.state)?.status;
  if (status !== "active" && status !== "failed") { throw new TypeError("OpenCode plugin has no state"); }
  return status === "failed";
}

async function scopedSkills(value: unknown, release: OpencodeRelease, cwd: string, env: NodeJS.ProcessEnv): Promise<SkillEntry[]> {
  const classify = await opencodeSkillScopes(cwd, env, release);
  return Promise.all(projectSkills(value, release.major).map(async skill => ({ ...skill, ...await classify(skill.source === "builtin" ? "<built-in>" : skill.path ?? "") })));
}

/** Native discovery without creating a session or submitting a model prompt. */
export const opencodeSkills: InventoryReader<SkillEntry> = async (installation, options = {}) => {
  if (installation.via !== "executable") { return unsupportedInventory("installation_unsupported", "OpenCode skills require an executable"); }
  const scope = workspaceScope(options);
  const result = await inventoryRead(async (signal, own) => {
    const release = await opencodeRelease(installation, { cwd: scope.cwd, signal, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), ...(options.env === undefined ? {} : { env: options.env }) });
    signal.throwIfAborted();
    if (release.major === 2 && (release.minor < 2 || (release.minor === 2 && release.patch < 7))) {
      return { kind: "unsupported", code: "version_unsupported", reason: "OpenCode v2 skills require the verified plugin activation barrier in 2.2.7 or newer", requiredVersion: "2.2.7", ...(installation.version === undefined ? {} : { installedVersion: installation.version }) };
    }
    const env = sessionEnvironment(options.env);
    if (release.major === 1) {
      return legacySkills(installation.command, scope, env, signal, async value => { const skills = await scopedSkills(value, release, scope.cwd, env); return skills; });
    }
    const password = randomBytes(24).toString("base64url");
    const child = own(spawnLineProcess(installation.command, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: scope.cwd, env: serveEnvironment(env, password), killTree: true, inheritStderr: false,
    }));
    const ready = endpoint(child, signal);
    // Observe an early process failure before awaiting startup.
    // oxlint-disable-next-line promise/prefer-await-to-then -- Readiness and process startup can reject independently.
    void ready.catch(() => {});
    await child.spawned;
    const origin = await ready;
    const read = async (path: string): Promise<JsonRecord[]> => { const rows = await query(origin, password, scope.cwd, signal, path); return rows; };
    // 2.2.7/2.3.0 provider.list awaits Plugin.awaitActivation; skill.list does not.
    // A successful empty provider catalog is also a completed activation barrier.
    await read("/api/provider");
    const plugins = await read("/api/plugin");
    const partial = plugins.map(plugin => pluginFailed(plugin)).some(Boolean);
    const skills = await read("/api/skill");
    return inventoryOk(scope, "discovered", await scopedSkills(skills, release, scope.cwd, env), partial);
  }, options.timeoutMs);
  return result;
};
