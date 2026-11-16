#!/usr/bin/env node
/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/no-unsafe-return, typescript/strict-boolean-expressions -- Standalone JavaScript audit outside the TypeScript project; manifests and AST nodes are inspected at runtime without executing host code. */
/**
 * Read-only OAR source-export and host-import audit. Run from any directory:
 *
 *   node experiments/public-api-sweep-2026-11-16/audit.mjs \
 *     --host raft=/path/to/raft --host ferry=/path/to/ferry
 *
 * --package PATH selects another OAR checkout's packages/oar directory.
 * To compare a baseline, repeat the same host arguments with --package
 * /path/to/baseline/packages/oar; compare revisions, entry counts and misses.
 * Without --host, only the package's export counts are reported.
 * --fail-on-missing exits 1 when named imports or entrypoints are missing.
 * Invalid arguments or an incomplete audit exit 2. Otherwise the exit is 0.
 *
 * The package manifest is authoritative: exact exports override wildcard
 * exports, including null exclusions. dist/*.d.ts targets map to src/*.ts;
 * the wildcard capture may contain slashes, as in Node's export patterns.
 * TypeScript resolves export stars and aliases, including type-only symbols.
 * It does not build the package or replace the repository's tsrs typecheck.
 *
 * Hosts must be Git worktrees. Scan tracked and unignored untracked JS/TS
 * files, including declaration files; do not follow source symlinks. Check
 * named imports, named re-exports and qualified import types by exported
 * name. A non-type import can still be used only as a type, so this is an
 * existence check, not a runtime-value or structural compatibility check.
 * Namespace imports/re-exports, whole-module type queries, require calls and
 * dynamic imports need manual review and are counted by package entrypoint.
 * Computed module strings and aliases propagated across host files are not
 * followed. Non-code exports, such as SVG assets, are counted but not checked.
 *
 * JSON contains revisions, counts and missing public import names only.
 * Never emit host file paths, local binding names, source or diagnostic text.
 * Dirty revisions describe the worktree being read, not a committed snapshot.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HELP = `Usage: node audit.mjs [--package PATH] [--host NAME=PATH ...] [--fail-on-missing]

Read-only export/import audit. NAME is a public label, not a host path.
Output omits host paths and source. Namespace/dynamic accesses require review.
Exit: 0 complete, 1 missing imports with --fail-on-missing, 2 incomplete/error.
`;

function optionsOf(args) {
  const options = {
    packagePath: fileURLToPath(new URL("../../packages/oar/", import.meta.url)),
    hosts: [], failOnMissing: false, help: false,
  };
  const names = new Set();
  for (let index = 0; index < args.length; index++) {
    const [flag, ...inline] = args[index].split("=");
    if (flag === "--help" || flag === "-h") {
      options.help = true;
    } else if (flag === "--fail-on-missing") {
      if (inline.length > 0) { throw new Error("--fail-on-missing takes no value"); }
      options.failOnMissing = true;
    } else if (flag === "--package" || flag === "--host") {
      const value = inline.length > 0 ? inline.join("=") : args[++index];
      if (!value || value.startsWith("--")) { throw new Error("--package and --host require a value"); }
      if (flag === "--package") {
        options.packagePath = path.resolve(value);
      } else {
        const separator = value.indexOf("=");
        const name = value.slice(0, separator);
        if (separator < 1 || !/^[\w.-]{1,80}$/u.test(name) || !value.slice(separator + 1)) {
          throw new Error("--host requires NAME=PATH; NAME may contain letters, digits, underscore, dot or hyphen");
        }
        if (names.has(name)) { throw new Error("--host names must be unique"); }
        names.add(name);
        options.hosts.push({ name, directory: path.resolve(value.slice(separator + 1)) });
      }
    } else {
      throw new Error("Unknown argument; use --help");
    }
  }
  return options;
}

function git(directory, args) {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 32 * 1024 * 1024,
  });
}

function revisionOf(directory) {
  return {
    revision: git(directory, ["rev-parse", "HEAD"]).trim(),
    dirty: git(directory, ["status", "--porcelain", "--untracked-files=normal"]).length > 0,
  };
}

function wildcardCapture(pattern, value) {
  const pieces = pattern.split("*");
  if (pieces.length !== 2) { throw new Error("Only single-wildcard export patterns are supported"); }
  const [prefix, suffix] = pieces;
  if (!value.startsWith(prefix) || !value.endsWith(suffix) || value.length < prefix.length + suffix.length) { return null; }
  return value.slice(prefix.length, value.length - suffix.length);
}

function selectedExport(exports, subpath) {
  if (Object.hasOwn(exports, subpath)) { return subpath; }
  return Object.keys(exports)
    .filter(key => key.includes("*") && wildcardCapture(key, subpath) !== null)
    .toSorted((a, b) => b.indexOf("*") - a.indexOf("*") || b.length - a.length)[0];
}

function declarationTarget(value) {
  if (value === null || typeof value === "string") { return value; }
  if (Array.isArray(value)) { throw new TypeError("Export target arrays are not supported by this source audit"); }
  if (typeof value === "object") {
    for (const condition of ["types", "import", "default"]) {
      if (Object.hasOwn(value, condition)) { return declarationTarget(value[condition]); }
    }
  }
  throw new Error("Unsupported export conditions in the package manifest");
}

function sourceTarget(target) {
  if (!target.startsWith("./dist/")) { return null; }
  const source = target.replace("./dist/", "src/");
  if (source.endsWith(".d.ts")) { return `${source.slice(0, -5)}.ts`; }
  if (source.endsWith(".js")) { return `${source.slice(0, -3)}.ts`; }
  throw new Error("Unsupported declaration target in the package manifest");
}

function exportSources(directory, manifest) {
  const files = readdirSync(path.join(directory, "src"), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
  const sources = new Map();
  const nonCode = new Set();
  const blocked = [];
  function addWildcard(key, source) {
    for (const file of files) {
      const capture = wildcardCapture(source, file);
      if (capture !== null) {
        const subpath = key.replace("*", capture);
        if (selectedExport(manifest.exports, subpath) === key) { sources.set(subpath, path.join(directory, file)); }
      }
    }
  }
  for (const [key, value] of Object.entries(manifest.exports)) {
    const target = declarationTarget(value);
    if (target === null) {
      blocked.push(key);
    } else {
      const source = sourceTarget(target);
      if (source === null) {
        nonCode.add(key);
      } else if (key.includes("*")) {
        addWildcard(key, source);
      } else {
        if (!files.includes(source)) { throw new Error("A package export has no corresponding source file"); }
        sources.set(key, path.join(directory, source));
      }
    }
  }
  return { sources, nonCode, blocked };
}

function packageSurface(directory) {
  const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
  const { sources, nonCode, blocked } = exportSources(directory, manifest);
  const config = ts.readConfigFile(path.join(directory, "tsconfig.json"), filename => ts.sys.readFile(filename));
  if (config.error) { throw new Error("Cannot read the package TypeScript configuration"); }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, directory);
  if (parsed.errors.length > 0) { throw new Error("Cannot parse the package TypeScript configuration"); }
  const program = ts.createProgram([...sources.values()], { ...parsed.options, noEmit: true, incremental: false });
  const checker = program.getTypeChecker();
  const symbols = new Map();
  const entrypoints = [];
  for (const [subpath, file] of [...sources].toSorted(([a], [b]) => a.localeCompare(b))) {
    const source = program.getSourceFile(file);
    const module = source && checker.getSymbolAtLocation(source);
    if (!module || program.getSyntacticDiagnostics(source).length > 0) { throw new Error("Cannot resolve a package source entrypoint"); }
    const exports = checker.getExportsOfModule(module);
    let reExportAliases = 0;
    let typeAliases = 0;
    for (const symbol of exports) {
      let target = symbol;
      if (symbol.flags & ts.SymbolFlags.Alias) {
        reExportAliases++;
        target = checker.getAliasedSymbol(symbol);
      }
      if (!target.declarations?.length) { throw new Error("Cannot resolve a package export alias"); }
      if (target.flags & ts.SymbolFlags.TypeAlias) { typeAliases++; }
    }
    const specifier = subpath === "." ? manifest.name : manifest.name + subpath.slice(1);
    symbols.set(subpath, new Set(exports.map(symbol => symbol.name)));
    entrypoints.push({ specifier, exports: exports.length, reExportAliases, typeAliases });
  }
  return {
    manifest, symbols, nonCode,
    report: { name: manifest.name, version: manifest.version, ...revisionOf(directory), entrypoints, nonCodeExports: [...nonCode].toSorted((a, b) => a.localeCompare(b)), blockedExports: blocked.toSorted((a, b) => a.localeCompare(b)) },
  };
}

function byModule(a, b) {
  const order = a.module.localeCompare(b.module);
  return order === 0 ? (a.name ?? "").localeCompare(b.name ?? "") : order;
}

function hostAudit(host, surface) {
  const directory = realpathSync(host.directory);
  const files = [...new Set(git(directory, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0"))]
    .filter(file => /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(file)).toSorted((a, b) => a.localeCompare(b));
  const counts = { scannedFiles: 0, importingFiles: 0, namedReferences: 0, typeOnlyReferences: 0, nonCodeImports: 0, skippedSymlinks: 0, unreadableFiles: 0, parseErrors: 0 };
  const missing = new Map();
  const missingEntrypoints = new Map();
  const review = new Map();
  const moduleOf = node => {
    if (node && ts.isStringLiteralLike(node) && (node.text === surface.manifest.name || node.text.startsWith(`${surface.manifest.name}/`))) { return node.text; }
    return null;
  };
  function entryFor(module) {
    return module === surface.manifest.name ? "." : `.${module.slice(surface.manifest.name.length)}`;
  }
  function present(module) {
    const subpath = entryFor(module);
    if (surface.symbols.has(subpath)) { return true; }
    const selected = selectedExport(surface.manifest.exports, subpath);
    if (surface.nonCode.has(selected)) {
      counts.nonCodeImports++;
    } else {
      missingEntrypoints.set(module, (missingEntrypoints.get(module) ?? 0) + 1);
    }
    return false;
  }
  function named(module, name, typeOnly) {
    counts.namedReferences++;
    if (typeOnly) { counts.typeOnlyReferences++; }
    if (!surface.symbols.get(entryFor(module)).has(name)) {
      const key = JSON.stringify([module, name]);
      const row = missing.get(key) ?? { module, name, references: 0, typeOnlyReferences: 0 };
      row.references++;
      if (typeOnly) { row.typeOnlyReferences++; }
      missing.set(key, row);
    }
  }
  function needsReview(module, kind) {
    const row = review.get(module) ?? { module, counts: {} };
    row.counts[kind] = (row.counts[kind] ?? 0) + 1;
    review.set(module, row);
  }
  for (const file of files) {
    let source = null;
    try {
      const filename = path.join(directory, file);
      if (lstatSync(filename).isSymbolicLink()) {
        counts.skippedSymlinks++;
      } else {
        source = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
      }
    } catch {
      counts.unreadableFiles++;
    }
    if (source) {
      counts.scannedFiles++;
      counts.parseErrors += source.parseDiagnostics.length;
      const state = { importing: false };
      const accept = (node) => {
        const module = moduleOf(node);
        if (module !== null) { state.importing = true; }
        return module !== null && present(module) ? module : null;
      };
      const visit = (node) => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
          const module = accept(node.moduleSpecifier);
          if (module !== null) {
            const clause = ts.isImportDeclaration(node) ? node.importClause : node;
            const typeOnly = ts.isImportDeclaration(node) ? clause?.phaseModifier === ts.SyntaxKind.TypeKeyword : node.isTypeOnly;
            if (ts.isImportDeclaration(node) && clause?.name) { named(module, "default", typeOnly); }
            const bindings = ts.isImportDeclaration(node) ? clause?.namedBindings : node.exportClause;
            if (bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings))) {
              for (const item of bindings.elements) { named(module, (item.propertyName ?? item.name).text, item.isTypeOnly || typeOnly); }
            } else if (bindings || ts.isExportDeclaration(node)) {
              let kind = "starReexports";
              if (bindings) { kind = ts.isImportDeclaration(node) ? "namespaceImports" : "namespaceReexports"; }
              needsReview(module, kind);
            }
          }
        } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
          const module = accept(node.argument.literal);
          if (module !== null) {
            let { qualifier } = node;
            while (qualifier && ts.isQualifiedName(qualifier)) { qualifier = qualifier.left; }
            if (qualifier) { named(module, qualifier.text, true); }
            else { needsReview(module, "namespaceTypeQueries"); }
          }
        } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
          const module = accept(node.moduleReference.expression);
          if (module !== null) { needsReview(module, "requireImports"); }
        } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
          const module = accept(node.arguments[0]);
          if (module !== null) { needsReview(module, node.expression.kind === ts.SyntaxKind.ImportKeyword ? "dynamicImports" : "requireCalls"); }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      if (state.importing) { counts.importingFiles++; }
    }
  }
  return {
    name: host.name, ...revisionOf(directory), ...counts,
    missing: [...missing.values()].toSorted(byModule),
    missingEntrypoints: [...missingEntrypoints].map(([module, references]) => ({ module, references })).toSorted(byModule),
    reviewNeeded: [...review.values()].toSorted(byModule),
  };
}

function main() {
  let options = null;
  try { options = optionsOf(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; return; }
  if (options.help) { process.stdout.write(HELP); return; }
  let surface = null;
  try { surface = packageSurface(realpathSync(options.packagePath)); }
  catch { process.stderr.write("Package audit failed; check the OAR package path, Git worktree, manifest, dependencies and TypeScript sources.\n"); process.exitCode = 2; return; }
  const hosts = [];
  for (const host of options.hosts) {
    try { hosts.push(hostAudit(host, surface)); }
    catch { process.stderr.write(`Host audit failed for ${host.name}; check the Git worktree and file access.\n`); process.exitCode = 2; return; }
  }
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, typescriptVersion: ts.version, package: surface.report, hosts }, null, 2)}\n`);
  if (hosts.some(host => host.unreadableFiles > 0 || host.parseErrors > 0)) { process.exitCode = 2; }
  else if (options.failOnMissing && hosts.some(host => host.missing.length > 0 || host.missingEntrypoints.length > 0)) { process.exitCode = 1; }
}

main();
