/* oxlint-disable oxc/no-map-spread -- Project only native metadata, never skill bodies or plugin errors. */
import type { InventoryReader, SkillEntry } from "../../contracts/inventory.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { boolField, inventoryOk, inventoryRead, named, nativeRows, textField, unsupportedInventory, workspaceScope } from "../../shared/inventory.js";
import { openDiscoveryServer } from "./discovery-server.js";
import { legacySkills } from "./skills-v1.js";
import { opencodeVersionLine, parseOpencodeVersionLine, type OpencodeRelease } from "./version.js";
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
    const version = await opencodeVersionLine(installation, { cwd: scope.cwd, signal, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), ...(options.env === undefined ? {} : { env: options.env }) });
    signal.throwIfAborted();
    const release = parseOpencodeVersionLine(version);
    if (release === undefined) { throw new Error("Unrecognized OpenCode version"); }
    if (release.major === "future" || (release.major === 2 && release.minor >= 4)) {
      return { kind: "unsupported", code: "version_unsupported", reason: "This OpenCode release has no verified way to wait for skill and plugin discovery to finish", installedVersion: version };
    }
    if (release.major === 2 && (release.minor < 2 || (release.minor === 2 && release.patch < 7))) {
      return { kind: "unsupported", code: "version_unsupported", reason: "OpenCode v2 skills require the verified plugin activation barrier introduced in 2.2.7", requiredVersion: "2.2.7", ...(installation.version === undefined ? {} : { installedVersion: installation.version }) };
    }
    const env = sessionEnvironment(options.env);
    if (release.major === 1) {
      return legacySkills(installation.command, scope, env, signal, async value => { const skills = await scopedSkills(value, release, scope.cwd, env); return skills; });
    }
    const read = await openDiscoveryServer(installation.command, scope.cwd, env, "skills", signal, own);
    // From 2.2.7 until 2.4.0, provider.list awaits Plugin.awaitActivation.
    // A successful empty provider catalog is also a completed activation barrier.
    await read("/api/provider");
    const plugins = await read("/api/plugin");
    const partial = plugins.map(plugin => pluginFailed(plugin)).some(Boolean);
    const skills = await read("/api/skill");
    return inventoryOk(scope, "discovered", await scopedSkills(skills, release, scope.cwd, env), partial);
  }, options.timeoutMs);
  return result;
};
