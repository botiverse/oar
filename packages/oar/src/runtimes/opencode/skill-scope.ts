import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SkillEntry } from "../../contracts/inventory.js";
import type { OpencodeRelease } from "./version.js";
import { environmentHome } from "../../shared/environment-home.js";
import { environmentValue } from "../../shared/environment.js";

interface Root { readonly path: string; readonly scope: "user" | "project" }
async function canonical(path: string): Promise<string | undefined> {
  try { return await realpath(path); } catch { return undefined; }
}
async function repository(directory: string): Promise<boolean> {
  try { await stat(join(directory, ".git")); return true; } catch { return false; }
}
function contains(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

/** Classify returned paths only under measured native roots, never by a brand substring. */
export async function opencodeSkillScopes(cwd: string, env: NodeJS.ProcessEnv, release: OpencodeRelease): Promise<(path: string) => Promise<Pick<SkillEntry, "scope">>> {
  const { major, version } = release;
  const builtinUrisVerified = major === 2 && ["2.2.7", "2.3.0"].includes(version);
  const home = environmentHome(env);
  const skillHome = environmentValue(env, "OPENCODE_TEST_HOME") ?? home;
  const xdg = environmentValue(env, "XDG_CONFIG_HOME");
  const configHome = xdg === undefined || xdg === "" ? join(home, ".config") : xdg;
  const config = (major === 2 ? environmentValue(env, "OPENCODE_CONFIG_DIR") : undefined) ?? join(configHome, "opencode");
  const roots: Root[] = [];
  const add = async (directory: string, scope: Root["scope"]): Promise<void> => {
    const path = await canonical(resolve(cwd, directory));
    // Native global roots must not re-enter through the project ancestor walk.
    if (path !== undefined && !roots.some(root => root.path === path)) { roots.push({ path, scope }); }
  };
  for (const directory of [join(skillHome, ".claude", "skills"), join(skillHome, ".agents", "skills"), join(config, "skills"), join(config, "skill")]) {
    await add(directory, "user");
  }
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    for (const brand of [".claude", ".agents", ".opencode"]) {
      await add(join(directory, brand, "skills"), "project");
      if (brand === ".opencode") { await add(join(directory, brand, "skill"), "project"); }
    }
    if (directory === dirname(directory)) { break; }
    // v1 discovers project skills up to its repository root; v2 walks ancestors.
    if (major === 1 && await repository(directory)) { break; }
  }
  return async (path) => {
    if (path === "<built-in>") { return { scope: "builtin" }; }
    // Only 2.2.7 and 2.3.0 establish these built-in registrations.
    // Other releases and third-party skill:// identities keep unknown scope.
    if (builtinUrisVerified && ["skill://opencode/SKILL.md", "skill://report/SKILL.md"].includes(path)) { return { scope: "builtin" }; }
    if (!isAbsolute(path)) { return {}; }
    const resolved = await canonical(path);
    if (resolved === undefined) { return {}; }
    const scopes = new Set(roots.filter(root => contains(root.path, resolved)).map(root => root.scope));
    const [scope] = scopes;
    return scopes.size === 1 && scope !== undefined ? { scope } : {};
  };
}
