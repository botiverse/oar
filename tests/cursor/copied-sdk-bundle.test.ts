import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { copiedSdkBundle } from "../../sea-trial/vendor/support/copied-sdk-bundle.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.map(async root => rm(root, { recursive: true, force: true }))); roots.length = 0; });
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oar-sdk-loader-"));
  roots.push(root);
  await mkdir(join(root, "chunks"));
  await writeFile(join(root, "index.js"), "entry");
  return root;
}

test("finds a renamed nested chunk without depending on its filename", async () => {
  const root = await fixture();
  const file = join(root, "chunks", "144.js");
  await writeFile(file, "before LOADER after");
  expect(await copiedSdkBundle(root, "LOADER")).toEqual({ file, source: "before LOADER after" });
});

test("missing loader reports every searched JavaScript file", async () => {
  const root = await fixture();
  await writeFile(join(root, "changed.js"), "different loader");
  await expect(copiedSdkBundle(root, "LOADER")).rejects.toThrow('Searched: ["changed.js","index.js"]');
});

test.for(["same file", "different files"])("rejects ambiguous anchors in %s", async (where) => {
  const root = await fixture();
  await writeFile(join(root, "one.js"), where === "same file" ? "LOADER LOADER" : "LOADER");
  if (where === "different files") { await writeFile(join(root, "two.js"), "LOADER"); }
  await expect(copiedSdkBundle(root, "LOADER")).rejects.toThrow("Expected one SDK loader observation anchor");
});
