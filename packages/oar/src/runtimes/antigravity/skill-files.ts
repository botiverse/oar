/* oxlint-disable no-await-in-loop -- Native discovery precedence is sequential; higher-priority names win. */
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { SkillEntry } from "../../contracts/inventory.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { antigravitySkillMetadata, type FileSkill } from "./skill-metadata.js";
import { skillPathExists as exists, skillJson as json, skillDirectories as directories, skillManifest as manifest } from "./skill-manifests.js";

const aliases = [".agent", ".agents", "_agent", "_agents"];
// Native root-agent mounts, not every directory extracted with the CLI.
const builtins = ["agy-customizations", "antigravity_guide", "automation", "migrate-agent-settings", "migrate-workflows", "run-workflow"];
export function hasAntigravityFileSkills(version: string | undefined): boolean { return version === "1.5.10" || version === "1.5.11"; }
async function repositoryDirectory(directory: string, signal: AbortSignal): Promise<boolean> {
  const dot = join(directory, ".git");
  if (await exists(join(dot, "HEAD"))) { return true; }
  try {
    const link = /^gitdir: (.+)\s*$/u.exec(await readFile(dot, { encoding: "utf8", signal }));
    return link?.[1] !== undefined && await exists(resolve(directory, link[1], "HEAD"));
  } catch { signal.throwIfAborted(); return false; }
}
async function workspaces(cwd: string, signal: AbortSignal): Promise<string[]> {
  const ancestors: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    signal.throwIfAborted(); ancestors.push(dir);
    if (await repositoryDirectory(dir, signal)) { return ancestors; }
    if (dirname(dir) === dir) { return [cwd]; }
  }
}
interface Discovery { readonly home: string; readonly cwd: string; readonly root: string; readonly signal: AbortSignal; readonly sources: Set<string> }
function add(items: Map<string, FileSkill>, skill: FileSkill | null, discovery: Discovery): void {
  if (skill === null || discovery.sources.has(skill.source)) { return; }
  discovery.sources.add(skill.source);
  if (!items.has(skill.item.name)) { items.set(skill.item.name, skill); }
}
async function scanSkills(items: Map<string, FileSkill>, paths: readonly string[], discovery: Discovery): Promise<void> {
  for (const path of paths) { add(items, await antigravitySkillMetadata(join(path, "SKILL.md"), discovery.signal), discovery); }
}
async function scanPlugins(items: Map<string, FileSkill>, paths: readonly string[], enabled: JsonRecord, discovery: Discovery): Promise<void> {
  for (const path of paths) {
    let meta: JsonRecord | null = null;
    for (const file of ["plugin.json", ".antigravity-plugin/plugin.json", ".gemini-plugin/plugin.json"]) {
      if (await exists(join(path, file))) { meta = await json(join(path, file), discovery.signal); break; }
    }
    if (meta === null || [meta.name, meta.version, meta.description].some(value => value !== undefined && value !== null && typeof value !== "string")
      || (meta.disabled !== undefined && meta.disabled !== null && typeof meta.disabled !== "boolean")) { continue; }
    const id = basename(path); const override = asRecord(enabled[id])?.enabled;
    if (override === false || (override !== true && meta.disabled === true)) { continue; }
    for (const dir of await directories(join(path, "skills"), discovery.signal)) {
      const skill = await antigravitySkillMetadata(join(dir, "SKILL.md"), discovery.signal);
      if (skill !== null) { add(items, { ...skill, item: { ...skill.item, name: `${id}:${skill.item.name}`, plugin: typeof meta.name === "string" && meta.name !== "" ? meta.name : id } }, discovery); }
    }
  }
}
/** No executable, authentication, MCP, body execution or builtin initialization. */
export async function readAntigravityFileSkills(home: string, cwd: string, signal: AbortSignal): Promise<{ readonly items: readonly SkillEntry[]; readonly partial: boolean }> {
  // Native process cwd is physical on POSIX; Windows retains its supplied spelling.
  const workspace = process.platform === "win32" ? resolve(cwd) : await realpath(cwd);
  const projects = await workspaces(workspace, signal);
  const discovery = { home, cwd, root: projects.at(-1) ?? cwd, signal, sources: new Set<string>() };
  const items = new Map<string, FileSkill>();
  const config = await json(join(home, ".gemini/config/config.json"), signal);
  const enabled = asRecord(config?.plugins) ?? {};
  const workspaceRoots = projects.toReversed().flatMap(project => aliases.map(alias => ({ path: join(project, alias), base: project })));
  const globalRoots = [join(home, ".gemini/antigravity-cli"), join(home, ".gemini/config"), join(home, ".gemini")];
  for (const { path } of workspaceRoots) {
    await scanSkills(items, await directories(join(path, "skills"), signal), discovery);
    await scanPlugins(items, await directories(join(path, "plugins"), signal), enabled, discovery);
  }
  for (const { path, base } of workspaceRoots) {
    const scope = { base, projectRoot: discovery.root, signal };
    await scanSkills(items, await manifest(join(path, "skills.json"), scope), discovery);
    await scanPlugins(items, await manifest(join(path, "plugins.json"), scope), enabled, discovery);
  }
  for (const path of globalRoots) {
    await scanSkills(items, await directories(join(path, "skills"), signal), discovery);
    await scanPlugins(items, await directories(join(path, "plugins"), signal), enabled, discovery);
  }
  // Native startup migrates the old CLI manifests into config, overwriting that copy.
  // Resolve the selected source without performing that write.
  const globalBase = join(home, ".gemini/config");
  const globalScope = { base: globalBase, signal };
  for (const kind of ["skills", "plugins"]) {
    const legacy = join(home, ".gemini/antigravity-cli", `${kind}.json`);
    const path = await exists(legacy) ? legacy : join(globalBase, `${kind}.json`);
    const paths = await manifest(path, globalScope);
    await (kind === "skills" ? scanSkills(items, paths, discovery) : scanPlugins(items, paths, enabled, discovery));
  }
  // native_swarm is conditionally mounted even with identical saved settings.
  // Omit that unverified builtin and report an incomplete inventory.
  const partial = true;
  for (const name of builtins) {
    const skill = await antigravitySkillMetadata(join(home, ".gemini/antigravity-cli/builtin/skills", name, "SKILL.md"), signal);
    if (skill !== null) { add(items, { ...skill, item: { ...skill.item, scope: "builtin" } }, discovery); }
  }
  signal.throwIfAborted();
  return { items: [...items.values()].filter(skill => !skill.hidden).map(skill => skill.item).toSorted((a, b) => a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)), partial };
}
