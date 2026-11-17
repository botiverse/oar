import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { InventoryReader, SkillEntry } from "../../contracts/inventory.js";
import { environmentHome } from "../../shared/environment-home.js";
import { inventoryOk, inventoryRead, workspaceScope } from "../../shared/inventory.js";
import { refuseReaderEnvironment } from "../../shared/refuse-environment.js";
import type { CursorSdkAccess } from "./access.js";
import { directSkillFiles, ignoredSkill, nestedSkillFiles, SKILL_BRANDS, within, type SkillScan } from "./skill-files.js";
import { skillIdentity, skillMetadata } from "./skill-metadata.js";

async function canonical(path: string): Promise<string> {
  try { return await realpath(path); } catch { return path; }
}
async function discover(cwd: string, home: string, env: NodeJS.ProcessEnv, scan: SkillScan): Promise<SkillEntry[]> {
  const roots = [join(cwd, ".cursor", "rules"), ...SKILL_BRANDS.map(brand => join(cwd, brand, "skills")), ...SKILL_BRANDS.map(brand => join(home, brand, "skills"))];
  const files: string[] = [];
  for (const root of roots) { files.push(...await directSkillFiles(root, scan)); }
  files.push(...await nestedSkillFiles(cwd, home, env, scan));
  const realCwd = await canonical(cwd);
  const realHome = await canonical(home);
  const managed = await canonical(join(home, ".cursor", "skills-cursor"));
  const seenPaths = new Set<string>();
  const seenKeys = new Set<string>();
  const items: SkillEntry[] = [];
  for (const path of files) {
    scan.signal.throwIfAborted();
    if (ignoredSkill(path)) { continue; }
    const real = await canonical(path);
    if (seenPaths.has(real)) { continue; }
    seenPaths.add(real);
    // SDK cN/lN checks canonical containment after loading. Excludes managed roots.
    if ((!within(realCwd, real) && !within(realHome, real)) || within(managed, real)) { continue; }
    const key = skillIdentity(path);
    if (seenKeys.has(key)) { continue; }
    const item = await skillMetadata(path, scan);
    if (item === undefined) { continue; }
    seenKeys.add(key);
    if (item === null) { continue; }
    const user = SKILL_BRANDS.some(brand => within(join(home, brand, "skills"), path));
    items.push({ ...item, source: user ? "user" : "workspace", scope: user ? "user" : "project" });
  }
  return items.toSorted((a, b) => Number(a.scope === "project") - Number(b.scope === "project"));
}

/** SDK 1.4.0 directory discovery. No SDK import, session, hooks, MCP or model request. */
export function cursorSkillsWith(access: CursorSdkAccess): InventoryReader<SkillEntry> {
  return async (_installation, options = {}) => {
    if (access.execution === "in_process") { refuseReaderEnvironment(options.env, "Cursor skills reflect the host SDK environment"); }
    const scope = workspaceScope(options);
    const env = access.environment(options.env);
    const controller = new AbortController();
    const scan: SkillScan = { partial: false, signal: controller.signal };
    try {
      return await inventoryRead(async () => inventoryOk(scope, "discovered", await discover(scope.cwd, environmentHome(env), env, scan), scan.partial), options.timeoutMs);
    } finally { controller.abort(); }
  };
}
