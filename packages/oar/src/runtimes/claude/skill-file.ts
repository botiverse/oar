import { isUtf8 } from "node:buffer";
import { readFile } from "node:fs/promises";
import { asRecord } from "../../shared/json.js";

function noScript(): never { throw new Error("Executable frontmatter is not supported"); }

/** What a skill file's own frontmatter declares, for telling which file a same-named command belongs to. */
export interface SkillFileDeclaration {
  /** Non-empty string `description`, trimmed; absent when not declared. */
  readonly description?: string;
  /** True when the file declares `user-invocable: false`. */
  readonly notUserInvocable: boolean;
}

/**
 * Read only `description` and `user-invocable` from a skill or command file's
 * frontmatter. Null when the file cannot be read or is not UTF-8 text.
 */
export async function skillFileDeclaration(path: string): Promise<SkillFileDeclaration | null> {
  try {
    const bytes = await readFile(path);
    if (!isUtf8(bytes) || bytes.includes(0)) { return null; }
    // Loaded on use: the Claude entry imports no parser until a skill join needs it.
    const { default: matter } = await import("gray-matter");
    const data = asRecord(matter(bytes.toString("utf8").replace(/^﻿/u, ""), { engines: { js: noScript, javascript: noScript } }).data);
    const description = data?.description;
    return { ...(typeof description === "string" && description.trim() !== "" ? { description: description.trim() } : {}), notUserInvocable: data?.["user-invocable"] === false };
  } catch {
    return null;
  }
}
