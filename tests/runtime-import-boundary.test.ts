import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";

const runtimes = path.resolve("packages/oar/src/runtimes");
const observe = path.resolve(runtimes, "../observe");

function observationImports(file: string): string[] {
  const { importedFiles } = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
  return importedFiles.map(ref => ref.fileName).filter(specifier => {
    const target = path.resolve(path.dirname(file), specifier);
    return target === observe || target.startsWith(observe + path.sep) || /^@botiverse\/oar\/observe(?:\/|$)/u.test(specifier);
  });
}

test("runtime adapters do not import the observation layer", () => {
  const files = readdirSync(runtimes, { recursive: true, encoding: "utf8" }).filter(name => /\.[cm]?[jt]sx?$/u.test(name));
  const violations = files.flatMap(name =>
    observationImports(path.join(runtimes, name)).map(specifier => `${name} imports ${specifier}`));
  expect(violations).toEqual([]);
});
