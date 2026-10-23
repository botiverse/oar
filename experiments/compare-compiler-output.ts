/** Compare saved dist trees from two compilers. No build, mutation or network.
 * Run: pnpm tsx experiments/compare-compiler-output.ts <before-dist> <after-dist>
 * Build caches are excluded. Declaration differences need manual review; executable and map-metadata
 * differences fail. See tsrs-migration-2026-10-20.md for the first observation.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

function files(root: string, relative = ""): string[] {
  return readdirSync(path.join(root, relative), { withFileTypes: true })
    .filter((entry) => entry.name !== ".tsbuildinfo")
    .flatMap((entry) => {
      const name = path.join(relative, entry.name);
      return entry.isDirectory() ? files(root, name) : [name];
    }).toSorted();
}

function mapMetadata(content: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(content);
  assert.ok(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
  return Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== "mappings"));
}

const [before, after] = process.argv.slice(2);
assert.ok(before !== undefined && before.length > 0 && after !== undefined && after.length > 0, "Pass <before-dist> <after-dist>");
const names = files(before);
assert.deepEqual(files(after), names, "Emitted file lists differ");
const declarations: string[] = [];
const maps: string[] = [];
let identical = 0;
for (const name of names) {
  const oldBytes: Buffer = readFileSync(path.join(before, name));
  const newBytes: Buffer = readFileSync(path.join(after, name));
  if (oldBytes.equals(newBytes)) {
    identical++;
  } else if (name.endsWith(".map")) {
    assert.deepEqual(mapMetadata(oldBytes.toString()), mapMetadata(newBytes.toString()), `${name}: map metadata differs`);
    maps.push(name);
  } else {
    assert.ok(name.endsWith(".d.ts"), `${name}: executable or other output differs`);
    declarations.push(name);
  }
}
console.log(JSON.stringify({ files: names.length, identical, changedDeclarations: declarations, changedMappings: maps }, null, 2));
