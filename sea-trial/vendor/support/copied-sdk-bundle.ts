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
