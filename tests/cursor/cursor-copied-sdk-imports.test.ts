import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";
import { runExecutable } from "../../packages/oar/src/shared/executable/index.js";

test.for(["sibling", "nested"])("copied SDK retains %s dependency resolution and local observer modules", async (layout) => {
  const { root, entry, copy, copyEntry } = await fixture(layout);
  try {
    const result = await runExecutable(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("tests/fixtures/copied-sdk-imports.ts"), entry, copy, copyEntry]);
    expect(result.ok, result.stderr).toBe(true);
    expect(result.stdout.trim()).toBe(JSON.stringify({ value: "installed transitive dependency", subpath: "subpath", local: "observer" }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function fixture(layout: string) {
  const temporary = await mkdtemp(join(tmpdir(), "oar-copied-sdk-imports-"));
  const root = await realpath(temporary);
  const sdk = join(root, "installed", "node_modules", "@fixture", "sdk");
  const copy = join(root, "copy");
  const dependencies = layout === "nested" ? join(sdk, "node_modules") : join(root, "installed", "node_modules");
  const entry = join(sdk, "dist", "esm", "index.mjs");
  const copyEntry = join(copy, "dist", "esm", "index.mjs");
  const source = 'import value from "fixture-dependency"; import subpath from "fixture-dependency/sub"; import local from "./local.mjs"; export default { value, subpath, local };';
  await Promise.all([
    put(entry, source), put(copyEntry, source),
    put(join(sdk, "dist", "esm", "local.mjs"), 'export default "original";'),
    put(join(copy, "dist", "esm", "local.mjs"), 'export default "observer";'),
    put(join(dependencies, "fixture-dependency", "package.json"), JSON.stringify({ type: "module", exports: { ".": { import: "./import.mjs", require: "./require.cjs" }, "./sub": "./sub.mjs" } })),
    put(join(dependencies, "fixture-dependency", "import.mjs"), 'export { default } from "fixture-child";'),
    put(join(dependencies, "fixture-dependency", "require.cjs"), 'module.exports = "wrong require condition";'),
    put(join(dependencies, "fixture-dependency", "sub.mjs"), 'export default "subpath";'),
    put(join(dependencies, "fixture-dependency", "node_modules", "fixture-child", "package.json"), '{"type":"module","exports":"./index.mjs"}'),
    put(join(dependencies, "fixture-dependency", "node_modules", "fixture-child", "index.mjs"), 'export default "installed transitive dependency";'),
  ]);
  return { root, entry, copy, copyEntry };
}

async function put(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}
