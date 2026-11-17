/** Private parsed values stay in memory; only allowlisted menu values leave the probe. */
import { homedir } from "node:os";
import paths from "node:path";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { asRecord } from "../../packages/oar/src/shared/json.js";

export interface ConfigFile { readonly label: string; readonly path: string }
export interface Snapshot {
  readonly file: string;
  readonly state: "parsed" | "missing" | "unreadable" | "invalid_json";
  readonly value?: unknown;
}

export function configFiles(cwd: string, env: NodeJS.ProcessEnv): ConfigFile[] {
  const configuredHome = env[process.platform === "win32" ? "USERPROFILE" : "HOME"];
  const home = configuredHome === undefined || configuredHome === "" ? homedir() : configuredHome;
  const root = paths.resolve(cwd, env.GEMINI_HOME === undefined || env.GEMINI_HOME === "" ? paths.join(home, ".gemini") : env.GEMINI_HOME);
  const files = ["antigravity-cli/settings.json", "antigravity-acp/settings.json", "config/config.json", "config/mcp_config.json", "settings.json"]
    .map(relative => ({ label: `profile/${relative}`, path: paths.join(root, relative) }));
  return [...files, { label: "workspace/.gemini/settings.json", path: paths.resolve(cwd, ".gemini/settings.json") }];
}

export async function snapshot(files: readonly ConfigFile[]): Promise<Snapshot[]> {
  const snapshots = await Promise.all(files.map(async ({ label: file, path }): Promise<Snapshot> => {
    let contents = "";
    try { contents = await readFile(path, "utf8"); }
    catch (error) { return { file, state: asRecord(error)?.code === "ENOENT" ? "missing" : "unreadable" }; }
    try { const value: unknown = JSON.parse(contents); return { file, state: "parsed", value }; }
    catch { return { file, state: "invalid_json" }; }
  }));
  return snapshots;
}

const menuKeys = new Set(["model", "modelId", "modelName", "defaultModel", "selectedModel", "effort", "thought_level", "thoughtLevel", "thinkingLevel", "reasoningEffort"]);
interface Change { readonly path: readonly string[]; readonly before: unknown; readonly after: unknown }

function visible(value: unknown, key: string, publicValues: ReadonlySet<string>): unknown {
  if (value === undefined) { return { present: false }; }
  // No hashes, fragments, account fields, arbitrary strings, or dynamic object keys.
  return { present: true, value: menuKeys.has(key) && typeof value === "string" && publicValues.has(value) ? value : "[redacted]" };
}

interface Position { readonly publicValues: ReadonlySet<string>; readonly path: readonly string[] }
function changes(before: unknown, after: unknown, { publicValues, path }: Position): Change[] {
  if (isDeepStrictEqual(before, after)) { return []; }
  const left = asRecord(before), right = asRecord(after);
  if (left !== null || right !== null) {
    return [...new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])].toSorted().flatMap(key =>
      changes(left?.[key], right?.[key], { publicValues, path: [...path, key] }));
  }
  const key = path.at(-1) ?? "";
  return [{ path: path.map(part => menuKeys.has(part) ? part : "[redacted-field]"),
    before: visible(before, key, publicValues), after: visible(after, key, publicValues) }];
}

export function compareSnapshots(before: readonly Snapshot[], after: readonly Snapshot[], publicValues: ReadonlySet<string>): unknown[] {
  return before.map((prior, index) => {
    const next = after[index];
    const comparable = (prior.state === "parsed" || prior.state === "missing") &&
      (next?.state === "parsed" || next?.state === "missing");
    return { file: prior.file, before: prior.state, after: next?.state ?? "unreadable",
      equal: comparable ? prior.state === next.state && isDeepStrictEqual(prior.value, next.value) : null,
      changes: comparable ? changes(prior.value, next.value, { publicValues, path: [] }) : [] };
  });
}
