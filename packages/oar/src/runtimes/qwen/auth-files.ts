import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse } from "dotenv";
import stripJsonComments from "strip-json-comments";
import { environmentValue } from "../../shared/environment.js";
import { environmentHome } from "../../shared/environment-home.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";

export interface QwenSettingsLayer { readonly source: string; readonly value: JsonRecord }
export interface QwenAuthFiles {
  readonly home: string;
  readonly qwenHome: string;
  readonly layers: readonly QwenSettingsLayer[];
  readonly dotenv: readonly Readonly<Record<string, string>>[];
}

/** Read configuration, never a token file; unreadable/non-regular files stay unknown. */
async function readConfiguration(file: string, signal: AbortSignal): Promise<string | undefined> {
  signal.throwIfAborted();
  try {
    const info = await stat(file);
    signal.throwIfAborted();
    if (!info.isFile() || info.size > 4 * 1024 * 1024) { throw new Error("Unsupported Qwen configuration file"); }
    return await readFile(file, { encoding: "utf8", signal });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") { return undefined; }
    throw new Error("Qwen configuration could not be read", { cause: error });
  }
}
export async function qwenCredentialFileExists(file: string, signal: AbortSignal): Promise<boolean> {
  try {
    signal.throwIfAborted();
    const info = await stat(file);
    signal.throwIfAborted();
    return info.isFile();
  }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") { return false; }
    throw new Error("Credential metadata could not be read", { cause: error });
  }
}
function configDirectory(value: string | undefined, home: string): string {
  if (value === undefined || value === "") { return path.join(home, ".qwen"); }
  return value === "~" || value.startsWith("~/") || value.startsWith("~\\")
    ? path.join(home, ...value.slice(2).split(/[/\\]+/u).filter(Boolean)) : path.resolve(value);
}

/** Qwen 0.26.2 user/system scope only. No workspace walk, migration, backup or write. */
export async function readQwenAuthFiles(env: Readonly<NodeJS.ProcessEnv>, signal: AbortSignal): Promise<QwenAuthFiles> {
  const home = environmentHome(env);
  const initial = environmentValue(env, "QWEN_HOME");
  let qwenHome = configDirectory(initial, home);
  const readEnv = async (file: string): Promise<Record<string, string>> => parse(await readConfiguration(file, signal) ?? "");
  // Native bootstrap reads QWEN_HOME before locating settings. An explicitly
  // present empty value prevents this bootstrap assignment too.
  if (initial === undefined) {
    for (const file of [path.join(qwenHome, ".env"), path.join(home, ".env")]) {
      const value = environmentValue(await readEnv(file), "QWEN_HOME");
      if (value !== undefined && value !== "") { qwenHome = configDirectory(value, home); break; }
    }
  }
  const defaultSystem = process.platform === "darwin" ? "/Library/Application Support/QwenCode/settings.json"
    : (process.platform === "win32" ? String.raw`C:\ProgramData\qwen-code\settings.json` : "/etc/qwen-code/settings.json");
  const systemOverride = environmentValue(env, "QWEN_CODE_SYSTEM_SETTINGS_PATH");
  const system = systemOverride === undefined || systemOverride === "" ? defaultSystem : systemOverride;
  const defaultsOverride = environmentValue(env, "QWEN_CODE_SYSTEM_DEFAULTS_PATH");
  const defaults = defaultsOverride === undefined || defaultsOverride === "" ? path.join(path.dirname(system), "system-defaults.json") : defaultsOverride;
  const layers: QwenSettingsLayer[] = [];
  for (const [source, file] of [["system defaults", defaults], ["user settings", path.join(qwenHome, "settings.json")], ["system settings", system]] as const) {
    const content = await readConfiguration(file, signal);
    if (content === undefined) { continue; }
    const parsed: unknown = JSON.parse(stripJsonComments(content.replace(/^\uFEFF/u, "")));
    const value = asRecord(parsed);
    if (value === null) { throw new Error("Qwen settings is not an object"); }
    const version = value.$version;
    if (version !== undefined && (!Number.isInteger(version) || typeof version !== "number" || version < 1 || version > 4)) { throw new Error("Unknown Qwen settings version"); }
    layers.push({ source, value });
  }
  const files = [...new Set([path.join(qwenHome, ".env"), path.join(home, ".qwen", ".env"), path.join(home, ".env")])];
  const dotenv = await Promise.all(files.map(async (file) => { const value = await readEnv(file); return value; }));
  return { home, qwenHome, layers, dotenv };
}
