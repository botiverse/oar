import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Locate the observed ESM loader by its contents, independent of chunk names. */
export async function copiedSdkBundle(root: string, anchor: string): Promise<{ file: string; source: string }> {
  const entries = await readdir(root, { recursive: true });
  const files = entries.filter(file => file.endsWith(".js")).toSorted();
  const matches: { file: string; source: string }[] = [];
  for (const file of files) {
    const source = await readFile(join(root, file), "utf8");
    if (source.includes(anchor)) { matches.push({ file: join(root, file), source }); }
  }
  const match = matches[0];
  assert.ok(matches.length === 1 && match !== undefined && match.source.split(anchor).length === 2,
    `Expected one SDK loader observation anchor; found ${String(matches.length)} matching files. Searched: ${JSON.stringify(files)}. Remeasure before updating the observer.`);
  return match;
}

/** The local skills loader creates its context just before reading loadNestedRules. */
export function cursorSkillsContextFactory(source: string, anchor: string): string {
  const end = source.indexOf(anchor);
  const start = source.lastIndexOf("async loadLocalExtensibility(", end);
  assert.ok(start !== -1 && end > start, "Missing Cursor local extensibility loader or skill observation anchor.");
  const loader = source.slice(start, end);
  const pattern = /\bconst\s+[\w$]+=(?<factory>\(0,[\w$]+\.[\w$]+\)\(\)),[\w$]+=[\w$]+\.loadNestedRules\b/gu;
  const matches = [...loader.matchAll(pattern)];
  const factory = matches[0]?.groups?.factory;
  assert.ok(matches.length === 1 && factory !== undefined,
    `Expected one Cursor skills context factory call, found ${String(matches.length)}. Remeasure before updating the observer.`);
  return factory;
}
