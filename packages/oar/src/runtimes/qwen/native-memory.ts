import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import stripJsonComments from "strip-json-comments";
import { parse } from "dotenv";
import type { SessionOptions } from "../../contracts/session.js";
import { environmentValue, sessionEnvironment } from "../../shared/environment.js";
import { environmentHome } from "../../shared/environment-home.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";
import { privateTempDir, sweepPrivateTempDirs, type PrivateTempDir } from "../../shared/private-temp.js";
import { semverAtLeast } from "../../shared/semver.js";

export const QWEN_DEFAULTS_PREFIX = "oar-qwen-defaults-";

// Qwen 0.26.0 settings schema & Config constructor (chunk-LBEBKAXU.js, chunk-BRVCK4XV.js, chunk-YGSOH3UK.js):
// defaults are enableManagedAutoMemory=true, enableManagedAutoDream=true, enableAutoSkill=false.
const MEMORY_KEYS = ["enableManagedAutoMemory", "enableManagedAutoDream", "enableAutoSkill"] as const;

// Qwen 0.26.0 runtime env gates that alter memory/auto-memory outside settings files:
// - QWEN_CODE_SIMPLE (bareMode: chunk-D7XCQWP2.js isBareMode, chunk-BRVCK4XV.js)
// - QWEN_CODE_SAFE_MODE (safeMode: chunk-YGSOH3UK.js isSafeModeEnv, chunk-BRVCK4XV.js)
// - QWEN_SANDBOX / SANDBOX (shellExecutionSandbox: chunk-DOLUT3XC.js validateExecutionSandboxSelection, chunk-YGSOH3UK.js)
// - QWEN_CODE_MEMORY_TEAM / QWEN_CODE_MEMORY_TEAM_SYNC / QWEN_CODE_MEMORY_STRUCTURED_RECALL (chunk-YGSOH3UK.js)
const UNMODELED_MEMORY_ENV_VARS = [
  "QWEN_CODE_SIMPLE",
  "QWEN_CODE_SAFE_MODE",
  "QWEN_SANDBOX",
  "SANDBOX",
  "QWEN_CODE_MEMORY_TEAM",
  "QWEN_CODE_MEMORY_TEAM_SYNC",
  "QWEN_CODE_MEMORY_STRUCTURED_RECALL",
] as const;

// Qwen 0.26.0 CLI flags that toggle bareMode, safeMode, or sandbox (chunk-BRVCK4XV.js).
const UNMODELED_MEMORY_FLAGS = new Set([
  "--bare", "--no-bare",
  "--safe-mode", "--no-safe-mode", "--safeMode", "--no-safeMode",
  "--sandbox", "--no-sandbox", "-s",
]);

function configDirectory(value: string | undefined, home: string): string {
  if (value === undefined || value === "") { return path.join(home, ".qwen"); }
  return value === "~" || value.startsWith("~/") || value.startsWith("~\\")
    ? path.join(home, ...value.slice(2).split(/[/\\]+/u).filter(Boolean))
    : path.resolve(value);
}

// Qwen 0.26.0 getSystemSettingsPath (chunk-PTHIQ7ZN.js).
function defaultSystemSettingsPath(): string {
  if (process.platform === "darwin") { return "/Library/Application Support/QwenCode/settings.json"; }
  if (process.platform === "win32") { return String.raw`C:\ProgramData\qwen-code\settings.json`; }
  return "/etc/qwen-code/settings.json";
}

async function readTextIfPresent(file: string): Promise<string | undefined> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 4 * 1024 * 1024) {
      throw new Error(`Unsupported Qwen settings file: ${file}`);
    }
    return await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") { return undefined; }
    throw error;
  }
}

// Qwen 0.26.0 readSettingsLayers strips UTF-8 BOM and JSONC comments (chunk-QSD5IW52.js).
async function readJsonObjectIfPresent(file: string): Promise<JsonRecord | undefined> {
  const text = await readTextIfPresent(file);
  if (text === undefined) { return undefined; }
  const parsed: unknown = JSON.parse(stripJsonComments(text.replace(/^\uFEFF/u, "")));
  const record = asRecord(parsed);
  if (record === null) { throw new Error(`Qwen settings file is not a JSON object: ${file}`); }
  return record;
}

/** Resolve Qwen's home, system settings and system-defaults paths matching Qwen 0.26.0+. */
async function resolveQwenPaths(env: Readonly<NodeJS.ProcessEnv>): Promise<{
  readonly home: string;
  readonly qwenHome: string;
  readonly systemSettingsPath: string;
  readonly systemDefaultsPath: string;
}> {
  const home = environmentHome(env);
  const initial = environmentValue(env, "QWEN_HOME");
  let qwenHome = configDirectory(initial, home);
  // Qwen 0.26.0 preResolveHomeEnvOverrides (chunk-LUL25ENJ.js) + HOME_ENV_BOOTSTRAP_KEYS (chunk-CVMMNPLX.js):
  // bootstraps QWEN_HOME from ~/.qwen/.env then ~/.env when unset in env (does not bootstrap system-settings/defaults paths).
  if (initial === undefined) {
    for (const file of [path.join(qwenHome, ".env"), path.join(home, ".env")]) {
      // oxlint-disable-next-line no-await-in-loop -- ordered bootstrap lookup.
      const text = await readTextIfPresent(file).catch((): undefined => undefined);
      const value = text === undefined ? undefined : environmentValue(parse(text), "QWEN_HOME");
      if (value !== undefined && value !== "") { qwenHome = configDirectory(value, home); break; }
    }
  }
  // Qwen 0.26.0 getSystemSettingsPath & getSystemDefaultsPath (chunk-PTHIQ7ZN.js):
  // system-defaults.json defaults to sibling of system settings path.
  const systemOverride = environmentValue(env, "QWEN_CODE_SYSTEM_SETTINGS_PATH");
  const systemSettingsPath = systemOverride === undefined || systemOverride === "" ? defaultSystemSettingsPath() : systemOverride;
  const defaultsOverride = environmentValue(env, "QWEN_CODE_SYSTEM_DEFAULTS_PATH");
  const systemDefaultsPath = defaultsOverride === undefined || defaultsOverride === ""
    ? path.join(path.dirname(systemSettingsPath), "system-defaults.json")
    : defaultsOverride;
  return { home, qwenHome, systemSettingsPath, systemDefaultsPath };
}

export interface QwenNativeMemorySetup {
  readonly env: NodeJS.ProcessEnv;
  readonly nativeMemory?: "on" | "off";
  cleanup(): void;
}

/** Sweep abandoned system-defaults temp dirs left by dead host processes. */
export async function sweepAbandonedQwenDefaults(): Promise<void> {
  await sweepPrivateTempDirs(QWEN_DEFAULTS_PREFIX);
}

function hasUnmodeledLaunchFlag(args: readonly string[] | undefined): boolean {
  for (const arg of args ?? []) {
    if (arg === "--") { return false; }
    const name = arg.startsWith("--") ? arg.slice(0, arg.includes("=") ? arg.indexOf("=") : arg.length) : arg;
    if (UNMODELED_MEMORY_FLAGS.has(name) || (arg.startsWith("-s") && arg.length > 2 && !arg.startsWith("--"))) {
      return true;
    }
  }
  return false;
}

function hasUnmodeledEnvOrArgs(options: SessionOptions, env: Readonly<NodeJS.ProcessEnv>): boolean {
  if (hasUnmodeledLaunchFlag(options.launchArgs)) { return true; }
  return UNMODELED_MEMORY_ENV_VARS.some((name) => {
    const value = environmentValue(env, name);
    return value !== undefined && value.trim() !== "";
  });
}

// Qwen 0.26.0 validateExecutionSandboxSelection (chunk-DOLUT3XC.js) & Config getters (chunk-YGSOH3UK.js):
// tools.executionSandbox or tools.sandbox can disable managed auto-memory, dream and auto-skill at runtime.
function hasSandboxSetting(layers: readonly JsonRecord[]): boolean {
  return layers.some((layer) => {
    const tools = asRecord(layer.tools);
    return tools !== null && ((tools.executionSandbox !== undefined && tools.executionSandbox !== false)
      || (tools.sandbox !== undefined && tools.sandbox !== false));
  });
}

function effectiveBoolean(layers: readonly JsonRecord[], key: (typeof MEMORY_KEYS)[number], fallback: boolean): boolean {
  let value = fallback;
  for (const layer of layers) {
    const memory = asRecord(layer.memory);
    if (memory !== null && typeof memory[key] === "boolean") {
      value = memory[key];
    }
  }
  return value;
}

// Qwen 0.26.0 isFolderTrustEnabled (chunk-TAW26O7I.js): defaults to false.
function folderTrustEnabled(layers: readonly JsonRecord[]): boolean {
  let enabled = false;
  for (const layer of layers) {
    const security = asRecord(layer.security);
    const folderTrust = asRecord(security?.folderTrust);
    if (typeof folderTrust?.enabled === "boolean") {
      enabled = folderTrust.enabled;
    }
  }
  return enabled;
}

function touchesMemoryKeys(layer: JsonRecord | undefined): boolean {
  const memory = asRecord(layer?.memory);
  return memory !== null && MEMORY_KEYS.some((key) => typeof memory[key] === "boolean");
}

async function canonicalPath(target: string): Promise<string> {
  try { return await realpath(path.resolve(target)); }
  catch { return path.resolve(target); }
}

async function readEffectiveNativeMemory(
  options: SessionOptions,
  env: Readonly<NodeJS.ProcessEnv>,
  paths: Awaited<ReturnType<typeof resolveQwenPaths>>,
  effectiveDefaultsPath: string,
  effectiveDefaultsRecord: JsonRecord | undefined,
): Promise<"on" | "off" | undefined> {
  if (hasUnmodeledEnvOrArgs(options, env)) { return undefined; }
  try {
    const defaultsLayer = effectiveDefaultsRecord ?? await readJsonObjectIfPresent(effectiveDefaultsPath);
    const userLayer = await readJsonObjectIfPresent(path.join(paths.qwenHome, "settings.json"));
    const systemLayer = await readJsonObjectIfPresent(paths.systemSettingsPath);
    // Qwen 0.26.0 Storage.getWorkspaceSettingsPath (chunk-EPODBRBP.js) reads only <cwd>/.qwen/settings.json (no parent search);
    // readSettingsLayers (chunk-QSD5IW52.js) skips workspace settings when realWorkspaceDir === realHomeDir.
    const [realCwd, realHome] = await Promise.all([canonicalPath(options.cwd), canonicalPath(paths.home)]);
    const workspaceLayer = realCwd === realHome ? undefined : await readJsonObjectIfPresent(path.join(options.cwd, ".qwen", "settings.json"));
    const trustInputs = [defaultsLayer, userLayer, systemLayer].filter((layer): layer is JsonRecord => layer !== undefined);
    if (folderTrustEnabled(trustInputs) && touchesMemoryKeys(workspaceLayer)) { return undefined; }
    // Qwen 0.26.0 mergeSettings (chunk-QSD5IW52.js): systemDefaults < user < workspace < system;
    // WORKSPACE_RESTRICTED_SETTINGS / WORKSPACE_NON_OVERRIDING_SETTINGS do not strip the three memory enable keys.
    const layers = [defaultsLayer, userLayer, workspaceLayer, systemLayer].filter((layer): layer is JsonRecord => layer !== undefined);
    if (hasSandboxSetting(layers)) { return undefined; }
    const active = effectiveBoolean(layers, "enableManagedAutoMemory", true)
      || effectiveBoolean(layers, "enableManagedAutoDream", true)
      || effectiveBoolean(layers, "enableAutoSkill", false);
    return active ? "on" : "off";
  } catch {
    return undefined;
  }
}

/**
 * Prepare Qwen's child environment for `nativeMemoryDefault: "off"` (merging
 * over any existing system-defaults file into a private 0700/0600 temp file
 * without mutating the original) and read back the effective native memory
 * state across Qwen's settings layers (`systemDefaults < user < workspace < system`).
 */
export async function prepareQwenNativeMemory(
  options: SessionOptions,
  env: NodeJS.ProcessEnv,
  version: string | undefined,
): Promise<QwenNativeMemorySetup> {
  const paths = await resolveQwenPaths(env);
  let temporary: PrivateTempDir | null = null;
  let childEnv = env;
  let effectiveDefaultsPath = paths.systemDefaultsPath;
  let effectiveDefaultsRecord: JsonRecord | undefined = undefined;

  if (options.nativeMemoryDefault === "off") {
    const existing = await readJsonObjectIfPresent(paths.systemDefaultsPath) ?? {};
    const existingMemory = asRecord(existing.memory) ?? {};
    effectiveDefaultsRecord = {
      ...existing,
      memory: {
        ...existingMemory,
        enableManagedAutoMemory: false,
        enableManagedAutoDream: false,
        enableAutoSkill: false,
      },
    };
    temporary = await privateTempDir(QWEN_DEFAULTS_PREFIX);
    try {
      effectiveDefaultsPath = path.join(temporary.path, "system-defaults.json");
      await writeFile(effectiveDefaultsPath, `${JSON.stringify(effectiveDefaultsRecord, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      childEnv = sessionEnvironment({ QWEN_CODE_SYSTEM_DEFAULTS_PATH: effectiveDefaultsPath }, env);
    } catch (error) {
      temporary.remove();
      throw error;
    }
  } else {
    await sweepAbandonedQwenDefaults();
  }

  const cleanup = (): void => { temporary?.remove(); };
  if (!semverAtLeast(version, "0.26.0")) {
    return { env: childEnv, cleanup };
  }
  const nativeMemory = await readEffectiveNativeMemory(options, childEnv, paths, effectiveDefaultsPath, effectiveDefaultsRecord);
  return nativeMemory === undefined ? { env: childEnv, cleanup } : { env: childEnv, nativeMemory, cleanup };
}
