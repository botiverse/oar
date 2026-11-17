/** Metadata only; scan the two native roots without following nested symlinks. */
/* oxlint-disable no-await-in-loop -- Preserve a deterministic traversal without unbounded open files. */
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { asRecord } from "../../packages/oar/src/shared/json.js";

export interface Root { readonly label: string; readonly path: string }
interface Metadata { readonly size: number; readonly mtimeMs: number; readonly kind: "file" | "symlink" }
export interface Inventory {
  readonly files: ReadonlyMap<string, Metadata>;
  readonly errors: readonly { path: string; code: string }[];
  readonly unscannedLinks: readonly string[];
}

function visiblePath(relative: string): string {
  return relative.split("/").map(part => /@|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}|[a-f\d]{32,}/iu.test(part)
    ? "[redacted-name]" : part).join("/");
}

export async function inventory(roots: readonly Root[]): Promise<Inventory> {
  const files = new Map<string, Metadata>();
  const errors: { path: string; code: string }[] = [];
  const unscannedLinks: string[] = [];
  const pending = roots.map(root => ({ ...root, root: true }));
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) { break; }
    try {
      const entries = await readdir(entry.path, { withFileTypes: true });
      for (const child of entries) {
        const absolute = path.join(entry.path, child.name), relative = `${entry.label}/${child.name}`;
        if (child.isDirectory()) { pending.push({ label: relative, path: absolute, root: false }); }
        else {
          const info = await lstat(absolute);
          files.set(relative, { size: info.size, mtimeMs: info.mtimeMs, kind: info.isSymbolicLink() ? "symlink" : "file" });
        }
        if (child.isSymbolicLink()) { unscannedLinks.push(visiblePath(relative)); }
      }
    } catch (error) {
      const code = asRecord(error)?.code;
      if (!(entry.root && code === "ENOENT")) {
        errors.push({ path: visiblePath(entry.label), code: typeof code === "string" && /^E[A-Z]+$/u.test(code) ? code : "unknown" });
      }
    }
  }
  return { files, errors, unscannedLinks };
}

export function compareInventory(before: Inventory, after: Inventory): object {
  const changed = [...new Set([...before.files.keys(), ...after.files.keys()])].toSorted().flatMap(relative => {
    const prior = before.files.get(relative);
    const next = after.files.get(relative);
    return prior?.size === next?.size && prior?.mtimeMs === next?.mtimeMs && prior?.kind === next?.kind ? [] :
      [{ path: visiblePath(relative), before: prior ?? null, after: next ?? null }];
  });
  return { complete: before.errors.length === 0 && after.errors.length === 0 && before.unscannedLinks.length === 0 && after.unscannedLinks.length === 0,
    beforeFileCount: before.files.size, afterFileCount: after.files.size, changed,
    beforeErrors: before.errors, afterErrors: after.errors,
    unscannedLinks: [...new Set([...before.unscannedLinks, ...after.unscannedLinks])].toSorted() };
}
