import path from "node:path";
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import type { SessionOptions } from "../../contracts/session.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { UnsupportedOptionError } from "../../contracts/errors.js";
import { claudeSessionEnv } from "./environment.js";
import type { JsonRecord } from "../../shared/json.js";

const MANAGED = new Set(["--setting-sources", "--settings", "--strict-mcp-config"]);

function canonicalPath(directory: string): string {
  try { return realpathSync(directory); }
  catch (error) {
    // A first use may not have a config directory yet.
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") { return directory; }
    throw error;
  }
}

function comparable(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function contains(directory: string, cwd: string): boolean {
  const relative = path.relative(comparable(directory), comparable(cwd));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function hasAliasedAncestor(home: string, config: string, cwd: string): boolean {
  const configReal = canonicalPath(config);
  if ([home, config].some((directory) => contains(canonicalPath(directory), canonicalPath(cwd)) && !contains(directory, cwd))) { return true; }
  for (let ancestor = cwd; ; ancestor = path.dirname(ancestor)) {
    const candidate = path.join(ancestor, ".claude");
    if (comparable(canonicalPath(candidate)) === comparable(configReal) && comparable(candidate) !== comparable(config)) { return true; }
    if (ancestor === path.dirname(ancestor)) { break; }
  }
  return false;
}

function refuseAliasedAncestors(home: string, config: string, cwd: string): void {
  // POSIX getcwd resolves aliases. Windows can preserve the launch spelling,
  // and Claude's own canonicalization is unverified, so inspect both chains.
  const canonical = canonicalPath(cwd);
  const candidates = process.platform === "win32" ? [cwd, canonical] : [canonical];
  if (candidates.some((candidate) => hasAliasedAncestor(home, config, candidate))) {
    throw new UnsupportedOptionError("userConfiguration", "Claude's ancestor scan can load this aliased user directory as project configuration. Use consistent canonical path spellings for cwd and HOME/CLAUDE_CONFIG_DIR, or omit userConfiguration: exclude. OAR leaves credential and session locations unchanged.");
  }
}

/** The child's native home and config paths, without moving its credential store. */
function configurationPaths(env: NodeJS.ProcessEnv, cwd: string): readonly string[] {
  const read = (name: string): string | undefined => process.platform === "win32"
    ? Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1] : env[name];
  const homeValue = read(process.platform === "win32" ? "USERPROFILE" : "HOME");
  const home = path.resolve(cwd, homeValue === "" || homeValue === undefined ? homedir() : homeValue);
  const configValue = read("CLAUDE_CONFIG_DIR");
  const config = path.resolve(cwd, configValue === "" || configValue === undefined ? path.join(home, ".claude") : configValue);
  refuseAliasedAncestors(home, config, path.resolve(cwd));
  // Claude's project ancestor walk can load user memory even with user
  // setting sources disabled. Include the default and an explicit config dir.
  return [...new Set([path.join(home, ".claude", "**"), path.join(config, "**"), path.join(home, "CLAUDE.md"), path.join(home, "CLAUDE.local.md")])].map((value) => process.platform === "win32" ? value.replaceAll("\\", "/") : value);
}

/** Native exclusion flags and child-only overrides; auth and refresh use the original store. */
export function claudeUserConfiguration(options: SessionOptions): { readonly args: readonly string[]; readonly settings: JsonRecord; readonly env: NodeJS.ProcessEnv } {
  const env = sessionEnvironment(claudeSessionEnv(options.env));
  if (options.userConfiguration !== "exclude") { return { args: [], settings: {}, env }; }
  for (const arg of options.launchArgs ?? []) {
    const flag = arg.split("=", 1)[0] ?? arg;
    if (MANAGED.has(flag)) {
      throw new UnsupportedOptionError("launchArgs", `claude launchArgs cannot include ${flag} with userConfiguration: exclude; OAR manages the exclusion settings`);
    }
  }
  return {
    args: ["--setting-sources", "project,local", "--strict-mcp-config"],
    settings: { claudeMdExcludes: configurationPaths(env, options.cwd) },
    env: sessionEnvironment({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false" }, env),
  };
}
