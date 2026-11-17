import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { asRecord } from "../../packages/oar/src/shared/json.js";

const family = (name: string): boolean => name.startsWith("@earendil-works/pi-") || name === "@earendil-works/chord" || name === "undici";
const readRecord = (file: string | URL) => asRecord(JSON.parse(readFileSync(file, "utf8")));

function packageFile(name: string, from: URL): string {
  const found = findPackageJSON(name, from);
  assert.ok(found !== undefined);
  return realpathSync(found);
}

function retainVersion(versions: Record<string, string>, data: Record<string, unknown>): void {
  assert.ok(typeof data.name === "string" && typeof data.version === "string");
  const previous = versions[data.name];
  assert.ok(previous === undefined || previous === data.version, `Conflicting accepted ${data.name} versions: ${String(previous)}, ${data.version}`);
  versions[data.name] = data.version;
}

export function resolvedPiVersions(parent: URL, names: readonly string[]): Record<string, string> {
  const versions: Record<string, string> = {};
  const seen = new Set<string>();
  function visit(name: string, from: URL): void {
    const file = packageFile(name, from);
    if (seen.has(file)) { return; }
    seen.add(file);
    const data = readRecord(file);
    assert.ok(data !== null);
    retainVersion(versions, data);
    for (const dependency of Object.keys(asRecord(data.dependencies) ?? {})) {
      if (family(dependency)) { visit(dependency, pathToFileURL(file)); }
    }
  }
  for (const name of names) { visit(name, parent); }
  return versions;
}

function compare(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) { return difference; }
  }
  return 0;
}

function upperBound(minimum: readonly number[], operator: string): number[] {
  const [major = 0, minor = 0, patch = 0] = minimum;
  if (operator === "~") { return [major, minor + 1, 0]; }
  if (major > 0) { return [major + 1, 0, 0]; }
  return minor > 0 ? [0, minor + 1, 0] : [0, 0, patch + 1];
}

/** Published OAR Pi ranges currently use exact, caret or tilde versions.
 * Refuse another range form rather than silently claiming it is compatible. */
export function satisfiesPublishedRange(version: string, range: string): boolean {
  assert.match(version, /^\d+\.\d+\.\d+$/u, "Unsupported Pi baseline/range");
  assert.match(range, /^[\^~]?\d+\.\d+\.\d+$/u, "Unsupported Pi baseline/range");
  const operator = range.startsWith("^") || range.startsWith("~") ? range.slice(0, 1) : "";
  const actual = version.split(".").map(Number);
  const minimum = range.slice(operator.length).split(".").map(Number);
  if (operator === "") { return compare(actual, minimum) === 0; }
  return compare(actual, minimum) >= 0 && compare(actual, upperBound(minimum, operator)) < 0;
}

function checkWorkspacePins(dependencies: Record<string, unknown>, names: readonly string[], versions: Record<string, string>): void {
  for (const name of names) {
    const actualName = name === "@earendil-works/pi-ai-durable" ? "@earendil-works/pi-ai" : name;
    const expected = name === "@earendil-works/pi-ai-durable" ? `npm:@earendil-works/pi-ai@${versions[actualName]}` : versions[actualName];
    assert.equal(dependencies[name], expected, `Workspace ${name} must resolve its exact accepted version`);
  }
}

function checkPublishedRanges(root: string, versions: Record<string, string>): void {
  const published = readRecord(path.join(root, "packages/oar/package.json"));
  for (const field of ["dependencies", "peerDependencies"]) {
    for (const [name, range] of Object.entries(asRecord(published?.[field]) ?? {})) {
      const version = versions[name];
      if (version !== undefined) {
        assert.ok(typeof range === "string" && satisfiesPublishedRange(version, range), `Accepted ${name}@${version} does not satisfy published ${String(range)}`);
      }
    }
  }
}

export function acceptedPiVersions(root: string): Record<string, string> {
  const parent = pathToFileURL(path.join(root, "package.json"));
  const dependencies = asRecord(readRecord(parent)?.devDependencies);
  assert.ok(dependencies !== null);
  const names = Object.keys(dependencies).filter(name => family(name));
  const versions = resolvedPiVersions(parent, names);
  checkWorkspacePins(dependencies, names, versions);
  checkPublishedRanges(root, versions);
  return versions;
}

function installMode(args: readonly string[]): "gate" | "published" {
  const options = args.filter(arg => arg !== "--");
  assert.ok(options.length <= 1 && (options.length === 0 || options[0] === "--mode=gate" || options[0] === "--mode=published"),
    "Usage: clean-install.ts [--mode=gate|--mode=published]");
  return options[0] === "--mode=published" ? "published" : "gate";
}

function hostVersions(host: string, expected: Record<string, string> | undefined): Record<string, string> {
  const parent = pathToFileURL(path.join(host, "node_modules/@botiverse/oar/package.json"));
  const actual = resolvedPiVersions(parent, ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "undici"]);
  if (expected !== undefined) {
    for (const [name, version] of Object.entries(actual)) { assert.equal(version, expected[name], `Host resolved a different ${name}`); }
  }
  return actual;
}

export function cleanInstallPolicy(root: string, args: readonly string[]) {
  const mode = installMode(args);
  const accepted = acceptedPiVersions(root);
  const directory = path.resolve(process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run", "clean-install");
  const evidence: { mode: string; overrides: Record<string, string>; actual: Record<string, string>; status: string } = {
    mode, overrides: mode === "gate" ? accepted : {}, actual: {}, status: "started",
  };
  const save = (): void => { mkdirSync(directory, { recursive: true }); writeFileSync(path.join(directory, `${mode}.json`), `${JSON.stringify(evidence, null, 2)}\n`); };
  save();
  return {
    mode, accepted, hostFields: mode === "gate" ? { overrides: accepted } : {}, npmOptions: mode === "gate" ? ["--save-exact"] : [],
    record(host: string): void {
      evidence.actual = hostVersions(host, mode === "gate" ? accepted : undefined);
      evidence.status = "installed";
      save();
    },
    passed(): void { evidence.status = "passed"; save(); },
  };
}
