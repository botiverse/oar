/* oxlint-disable eslint/max-statements -- AST walks collect import aliases and check call ancestry in one traversal each. */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";

// Audit both host code and embedded Node scripts. This is a source convention
// check, not a sandbox: process creation must visibly enter spawnChecked.
function unguardedSpawns(source: string, filename: string): string[] {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const names = new Set(["spawn"]);
  const failures: string[] = [];
  const imports = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const module = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (module === "cross-spawn" && clause?.name !== undefined) { names.add(clause.name.text); }
      const bindings = clause?.namedBindings;
      if ((module === "node:child_process" || module === "child_process") && bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          if ((binding.propertyName ?? binding.name).text === "spawn") { names.add(binding.name.text); }
        }
      }
    }
    if (ts.isBindingElement(node) && node.propertyName?.getText(file) === "spawn" && ts.isIdentifier(node.name)) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, imports);
  };
  imports(file);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const spawning = ts.isIdentifier(callee) ? names.has(callee.text)
        : ts.isPropertyAccessExpression(callee) && callee.name.text === "spawn";
      if (spawning) {
        const arrow = node.parent;
        const call = arrow.parent;
        if (!(ts.isArrowFunction(arrow) && arrow.body === node && ts.isCallExpression(call)
          && ts.isIdentifier(call.expression) && call.expression.text === "spawnChecked" && call.arguments[0] === arrow)) {
          failures.push(`${filename}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`);
        }
      }
    }
    if (ts.isTaggedTemplateExpression(node) && node.tag.getText(file) === "String.raw" && ts.isNoSubstitutionTemplateLiteral(node.template)) {
      failures.push(...unguardedSpawns(node.template.rawText ?? node.template.text, `${filename}:embedded`));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return failures;
}

test("all package spawns enter the validation-error boundary, including embedded watchdogs", () => {
  const root = path.resolve("packages/oar/src");
  const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".ts"));
  const failures = files.flatMap((name) => unguardedSpawns(readFileSync(path.join(root, name), "utf8"), name));
  expect(failures).toEqual([]);
});

test.each([
  'import { spawn as start } from "node:child_process"; start("node");',
  'import launch from "cross-spawn"; launch("node");',
  'import * as cp from "node:child_process"; cp.spawn("node");',
  'const {spawn: start} = require("node:child_process"); start("node");',
  'const script = String.raw`const {spawn} = require("node:child_process"); spawn("node");`;',
])("the guard rejects an unwrapped launch: %s", (source) => {
  expect(unguardedSpawns(source, "example.ts")).toHaveLength(1);
});

test("the guard accepts a directly protected native call", () => {
  expect(unguardedSpawns('import {spawn} from "node:child_process"; spawnChecked(() => spawn("node"));', "example.ts")).toEqual([]);
});
