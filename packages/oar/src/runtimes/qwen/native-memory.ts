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

const MEMORY_KEYS = ["enableManagedAutoMemory", "enableManagedAutoDream", "enableAutoSkill"] as const;

function configDirectory(value: string | undefined, home: string): string {
  if (value === undefined || value === "") { return path.join(home, ".qwen"); }
  return value === "~" || value.startsWith("~/") || value.startsWith("~\\")
    ? path.join(home, ...value.slice(2).split(/[/\\]+/u).filter(Boolean))
    : path.resolve(value);
}

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
  if (initial === undefined) {
    for (const file of [path.join(qwenHome, ".env"), path.join(home, ".env")]) {
      // oxlint-disable-next-line no-await-in-loop -- ordered bootstrap lookup.
      const text = await readTextIfPresent(file).catch((): undefined => undefined);
      const value = text === undefined ? undefined : environmentValue(parse(text), "QWEN_HOME");
      if (value !== undefined && value !== "") { qwenHome = configDirectory(value, home); break; }
    }
  }
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

  try {
    const defaultsLayer = effectiveDefaultsRecord ?? await readJsonObjectIfPresent(effectiveDefaultsPath);
    const userLayer = await readJsonObjectIfPresent(path.join(paths.qwenHome, "settings.json"));
    const systemLayer = await readJsonObjectIfPresent(paths.systemSettingsPath);
    const [realCwd, realHome] = await Promise.all([canonicalPath(options.cwd), canonicalPath(paths.home)]);
    const workspaceLayer = realCwd === realHome
      ? undefined
      : await readJsonObjectIfPresent(path.join(options.cwd, ".qwen", "settings.json"));

    const trustInputs = [defaultsLayer, userLayer, systemLayer].filter((layer): layer is JsonRecord => layer !== undefined);
    if (folderTrustEnabled(trustInputs) && touchesMemoryKeys(workspaceLayer)) {
      // Folder trust is enabled and workspace settings toggle memory; omit rather than guessing trust.
      return { env: childEnv, cleanup };
    }

    const layers = [defaultsLayer, userLayer, workspaceLayer, systemLayer].filter((layer): layer is JsonRecord => layer !== undefined);
    const active = effectiveBoolean(layers, "enableManagedAutoMemory", true)
      || effectiveBoolean(layers, "enableManagedAutoDream", true)
      || effectiveBoolean(layers, "enableAutoSkill", false);
    return { env: childEnv, nativeMemory: active ? "on" : "off", cleanup };
  } catch {
    // Unreadable or malformed settings layer: omit nativeMemory rather than guessing.
    return { env: childEnv, cleanup };
  }
}
