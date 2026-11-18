import { isUtf8 } from "node:buffer";
import { readFile } from "node:fs/promises";
import { asRecord } from "../../shared/json.js";

function noScript(): never { throw new Error("Executable frontmatter is not supported"); }

/**
 * A skill or command file's own frontmatter `description`, read only to tell
 * which file a same-named Claude command belongs to. Null when the file cannot
 * be read, is not UTF-8 text, or declares no non-empty string description.
 */
export async function frontmatterDescription(path: string): Promise<string | null> {
  try {
    const bytes = await readFile(path);
    if (!isUtf8(bytes) || bytes.includes(0)) { return null; }
    // Loaded on use: the Claude entry imports no parser until a skill join needs it.
    const { default: matter } = await import("gray-matter");
    const data = asRecord(matter(bytes.toString("utf8").replace(/^﻿/u, ""), { engines: { js: noScript, javascript: noScript } }).data);
    const description = data?.description;
    return typeof description === "string" && description.trim() !== "" ? description.trim() : null;
  } catch {
    return null;
  }
}
