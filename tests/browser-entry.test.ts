import { build } from "esbuild";
import { expect, test } from "vitest";

test.each(["browser", "pi-durable"])("the complete %s entry bundles without Node imports or externals", async (entry) => {
  const result = await build({
    entryPoints: [`packages/oar/src/${entry}.ts`], bundle: true, platform: "browser", format: "esm", write: false, metafile: true,
    plugins: [{ name: "no-node", setup(builder) {
      // esbuild uses Go regexes, which do not accept JavaScript Unicode flags.
      // oxlint-disable-next-line require-unicode-regexp
      builder.onResolve({ filter: /^node:/ }, (args) => ({ errors: [{ text: `Node import ${args.path} from ${args.importer}` }] }));
    } }],
  });
  expect(Object.values(result.metafile.outputs).flatMap((output) => output.imports)).toEqual([]);
  expect(result.outputFiles[0]?.text).toContain(entry === "browser" ? "createSessionKernel" : "createPiDurableRuntime");
  if (entry === "browser") {
    expect(Object.keys(result.metafile.inputs).filter((file) => /pi-durable|chord/u.test(file))).toEqual([]);
  }
});
