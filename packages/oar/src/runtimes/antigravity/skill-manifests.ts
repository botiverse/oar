/* oxlint-disable no-await-in-loop -- Preserve native entry and inheritance precedence. */
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { asRecord, parseJson, type JsonRecord } from "../../shared/json.js";

export async function skillPathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}
export async function skillJson(path: string, signal: AbortSignal): Promise<JsonRecord | null> {
  try { return asRecord(parseJson(await readFile(path, { encoding: "utf8", signal }))); }
  catch { signal.throwIfAborted(); return null; }
}
export async function skillDirectories(path: string, signal: AbortSignal): Promise<string[]> {
  signal.throwIfAborted();
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory()).map(entry => join(path, entry.name)).toSorted();
  } catch { signal.throwIfAborted(); return []; }
}
export interface ManifestScope { readonly base: string; readonly projectRoot?: string; readonly signal: AbortSignal }
async function declaredPath(value: string, scope: ManifestScope): Promise<string | null> {
  const local = resolve(scope.base, value);
  if (scope.projectRoot === undefined) { return local; }
  const path = await skillPathExists(local) ? local : resolve(scope.projectRoot, value);
  const within = relative(scope.projectRoot, path);
  return within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within) ? null : path;
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
export async function skillManifest(path: string, scope: ManifestScope, seen = new Set<string>()): Promise<string[]> {
  scope.signal.throwIfAborted();
  if (seen.has(path)) { return []; }
  seen.add(path);
  const data = await skillJson(path, scope.signal) ?? {};
  const result: string[] = [];
  for (const value of Array.isArray(data.entries) ? data.entries : []) {
    const entry = asRecord(value);
    if (typeof entry?.path !== "string") { continue; }
    const parent = await declaredPath(entry.path, scope);
    if (parent === null) { continue; }
    const only = strings(entry.include_only);
    const excluded = new Set(strings(entry.exclude));
    const children = only.length > 0 ? only.map(name => join(parent, name)) : await skillDirectories(parent, scope.signal);
    result.push(...children.filter(child => !excluded.has(child.slice(parent.length + 1))));
  }
  for (const value of Array.isArray(data.inherits) ? data.inherits : []) {
    const entry = asRecord(value);
    if (typeof entry?.path !== "string") { continue; }
    const inheritedPath = await declaredPath(entry.path, scope);
    if (inheritedPath === null) { continue; }
    const inherited = await skillManifest(inheritedPath, scope, seen);
    const only = strings(entry.include_only);
    const excluded = new Set(strings(entry.exclude));
    result.push(...inherited.filter(child => (only.length === 0 || only.includes(basename(child))) && !excluded.has(basename(child))));
  }
  return result;
}
