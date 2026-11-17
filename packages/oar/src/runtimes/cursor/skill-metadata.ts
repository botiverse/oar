import { isUtf8 } from "node:buffer";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import matter from "gray-matter";
import type { SkillEntry } from "../../contracts/inventory.js";
import { asRecord } from "../../shared/json.js";
import type { SkillScan } from "./skill-files.js";

function noScript(): never { throw new Error("Executable frontmatter is not supported"); }
function descriptionText(value: unknown): string {
  if (typeof value !== "string") { return ""; }
  // SDK No(value, 1536) avoids slicing a UTF-16 surrogate pair.
  const boundary = value.codePointAt(1535) ?? 0;
  return value.slice(0, boundary > 0xFF_FF ? 1535 : 1536);
}

/** Metadata only; malformed entries make the inventory partial, never leak their bodies/errors. */
export async function skillMetadata(path: string, scan: SkillScan): Promise<SkillEntry | null | undefined> {
  scan.signal.throwIfAborted();
  try {
    const bytes = await readFile(path, { signal: scan.signal });
    if (!isUtf8(bytes) || bytes.includes(0)) { scan.partial = true; return null; }
    const parsed: unknown = matter(bytes.toString("utf8").replace(/^\uFEFF/u, ""), { engines: { js: noScript, javascript: noScript } }).data;
    const data = asRecord(parsed) ?? {};
    const rawSurfaces = asRecord(data.metadata)?.surfaces;
    const surfaces = Array.isArray(rawSurfaces) ? rawSurfaces : (typeof rawSurfaces === "string" ? rawSurfaces.split(",").map(part => part.trim()).filter(Boolean) : []);
    if ((surfaces.length > 0 && !surfaces.includes("sdk")) || data.alwaysApply === true) { return undefined; }
    const description = descriptionText(data.description);
    const disableModelInvocation = data["disable-model-invocation"] === true;
    if (description.length === 0 && !disableModelInvocation) { scan.partial = true; return null; }
    return { name: basename(dirname(path)), path, description, disableModelInvocation };
  } catch { scan.partial = true; return null; }
}

/** SDK Rf/Tf merges identical relative paths across compatibility directories. */
export function skillIdentity(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  for (const brand of [".cursor", ".claude", ".codex", ".grok", ".agents"]) {
    const offset = normalized.toLowerCase().indexOf(`/${brand}/`);
    if (offset !== -1) { return `${normalized.slice(0, offset)}::${normalized.slice(offset + brand.length + 2)}`; }
  }
  return path;
}
