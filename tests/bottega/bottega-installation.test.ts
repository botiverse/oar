import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, expect, test } from "vitest";
import { bottegaInstallationFor } from "../../packages/oar/src/runtimes/bottega/installation.js";
import { clearInstallationCache } from "../../packages/oar/src/shared/installation.js";

const posixTest = test.skipIf(process.platform === "win32");
const scratch = mkdtempSync(path.join(tmpdir(), "oar-bottega-install-"));
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });
afterEach(() => { clearInstallationCache(); });

function writeExecutable(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

function makeBottegaBinary(dir: string, version: string): string {
  return writeExecutable(dir, "bottega", [
    String.raw`for arg in "$@"; do`,
    String.raw`  case "$arg" in`,
    String.raw`    --help) printf '%s\n' "bottega ${"\u2014"} fake cli"; exit 0 ;;`,
    String.raw`    --version) printf '%s\n' ${JSON.stringify(version)}; exit 0 ;;`,
    "  esac",
    "done",
    "exit 0",
  ].join("\n"));
}

function makeFakeNpm(dir: string, prefixDir: string): string {
  return writeExecutable(dir, "npm", String.raw`printf '%s\n' ${JSON.stringify(prefixDir)}`);
}

function makeBundledManifest(): string {
  const pkgDir = mkdtempSync(path.join(scratch, "bundled-"));
  const cliPath = path.join(pkgDir, "cli.js");
  const manifestPath = path.join(pkgDir, "package.json");
  writeFileSync(cliPath, "");
  writeFileSync(manifestPath, JSON.stringify({ name: "@botiverse/bottega", bin: { bottega: "cli.js" } }));
  return manifestPath;
}

posixTest("normal Node hosts resolve bundled @botiverse/bottega", async () => {
  const manifest = makeBundledManifest();
  const probe = bottegaInstallationFor({
    compiledSingleExecutable: false,
    electron: false,
    resolveModule: (specifier) => specifier === "@botiverse/bottega/package.json" ? manifest : null,
  });
  expect(await probe({ env: { PATH: "", OAR_BOTTEGA_BIN: "" } })).toEqual({ kind: "available", via: "bundled" });
});

posixTest.each([
  ["SEA", { compiledSingleExecutable: true, electron: false }],
  ["Electron", { compiledSingleExecutable: false, electron: true }],
])("%s hosts skip bundled resolution and return not_found when absent", async (_label, hostFlags) => {
  const manifest = makeBundledManifest();
  const emptyDir = mkdtempSync(path.join(scratch, "empty-"));
  const probe = bottegaInstallationFor({
    ...hostFlags,
    resolveModule: (specifier) => specifier === "@botiverse/bottega/package.json" ? manifest : null,
  });
  expect(await probe({ env: { PATH: emptyDir, OAR_BOTTEGA_BIN: "" } })).toEqual({ kind: "not_found" });
});

posixTest("SEA hosts discover bottega on PATH", async () => {
  const binDir = mkdtempSync(path.join(scratch, "path-bin-"));
  const bottegaPath = makeBottegaBinary(binDir, "0.3.0");
  const probe = bottegaInstallationFor({
    compiledSingleExecutable: true,
    electron: false,
    resolveModule: () => null,
  });
  expect(await probe({ env: { PATH: binDir, OAR_BOTTEGA_BIN: "" } })).toEqual({
    kind: "available",
    via: "executable",
    command: bottegaPath,
    version: "0.3.0",
  });
});

posixTest("SEA hosts fall back to npm global bin when bottega is absent from PATH", async () => {
  const npmDir = mkdtempSync(path.join(scratch, "npm-bin-"));
  const prefixDir = mkdtempSync(path.join(scratch, "npm-prefix-"));
  const globalBottega = makeBottegaBinary(path.join(prefixDir, "bin"), "0.3.0");
  makeFakeNpm(npmDir, prefixDir);
  const probe = bottegaInstallationFor({
    compiledSingleExecutable: true,
    electron: false,
    resolveModule: () => null,
  });
  expect(await probe({ env: { PATH: npmDir, OAR_BOTTEGA_BIN: "" } })).toEqual({
    kind: "available",
    via: "executable",
    command: globalBottega,
    version: "0.3.0",
  });
});

posixTest("OAR_BOTTEGA_BIN is exclusive over bundled and npm global fallbacks", async () => {
  const manifest = makeBundledManifest();
  const npmDir = mkdtempSync(path.join(scratch, "excl-npm-"));
  const prefixDir = mkdtempSync(path.join(scratch, "excl-prefix-"));
  makeBottegaBinary(path.join(prefixDir, "bin"), "0.3.0");
  makeFakeNpm(npmDir, prefixDir);
  const validBin = makeBottegaBinary(mkdtempSync(path.join(scratch, "excl-bin-")), "0.3.0");
  const probe = bottegaInstallationFor({
    compiledSingleExecutable: false,
    electron: false,
    resolveModule: (specifier) => specifier === "@botiverse/bottega/package.json" ? manifest : null,
  });
  expect(await probe({ env: { PATH: npmDir, OAR_BOTTEGA_BIN: path.join(scratch, "missing-bottega") } })).toEqual({
    kind: "not_found",
  });
  expect(await probe({ env: { PATH: npmDir, OAR_BOTTEGA_BIN: validBin } })).toEqual({
    kind: "available",
    via: "executable",
    command: validBin,
    version: "0.3.0",
  });
});

posixTest("outdated PATH bottega returns version_unsupported without falling through to npm global bin", async () => {
  const pathBinDir = mkdtempSync(path.join(scratch, "old-path-"));
  const npmDir = mkdtempSync(path.join(scratch, "new-npm-"));
  const prefixDir = mkdtempSync(path.join(scratch, "new-prefix-"));
  const oldBottega = makeBottegaBinary(pathBinDir, "0.2.9");
  makeBottegaBinary(path.join(prefixDir, "bin"), "0.3.0");
  makeFakeNpm(npmDir, prefixDir);
  const probe = bottegaInstallationFor({
    compiledSingleExecutable: true,
    electron: false,
    resolveModule: () => null,
  });
  expect(await probe({ env: { PATH: `${pathBinDir}${path.delimiter}${npmDir}`, OAR_BOTTEGA_BIN: "" } })).toMatchObject({
    kind: "unsupported",
    code: "version_unsupported",
    via: "executable",
    command: oldBottega,
    installedVersion: "0.2.9",
    requiredVersion: "0.3.0",
  });
});
