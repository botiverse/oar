import { build, type Metafile } from "esbuild";
import { expect, test } from "vitest";

/*
 * `@botiverse/oar/runtimes/<id>` loads one runtime without the others (a host
 * reading one provider's usage keeps a few MB, not the root entry's ~50 MB).
 * Every SDK must stay behind a dynamic import: the ACP SDK (~20 MB of heap)
 * loads when an ACP runtime first opens a session, lists models or (grok)
 * reads usage, and the pi and cursor SDKs when theirs first run. This walks
 * each entry's static imports only and allows nothing beyond Node's modules
 * and two small process helpers.
 */

/** All an entry may import statically besides its own files: Node's modules and two small process helpers. */
const light = (name: string): boolean => name.startsWith("node:") || name === "which" || name === "cross-spawn";

/** The static (not `import()`) edges out of one bundled file: files to follow and external packages. */
function staticEdges(metafile: Metafile, file: string): { readonly files: readonly string[]; readonly packages: readonly string[] } {
  const edges = (metafile.inputs[file]?.imports ?? []).filter((edge) => edge.kind !== "dynamic-import");
  return {
    files: edges.filter((edge) => edge.external !== true).map((edge) => edge.path),
    packages: edges.filter((edge) => edge.external === true).map((edge) => edge.path),
  };
}

/** The packages `file` reaches through static imports alone, skipping files in `reached`. */
function staticPackages(metafile: Metafile, file: string, reached = new Set<string>()): ReadonlySet<string> {
  reached.add(file);
  const { files, packages } = staticEdges(metafile, file);
  const found = new Set(packages);
  for (const next of files.filter((candidate) => !reached.has(candidate))) {
    for (const name of staticPackages(metafile, next, reached)) { found.add(name); }
  }
  return found;
}

test.each(["claude", "codex", "pi", "cursor", "opencode", "kimi", "grok", "antigravity", "qwen", "qoder"])("the %s entry statically imports no runtime SDK", async (id) => {
  const entry = `packages/oar/src/runtimes/${id}/index.ts`;
  const result = await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", write: false, metafile: true, packages: "external" });
  expect([...staticPackages(result.metafile, entry)].filter((name) => !light(name))).toEqual([]);
});
