import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findOwningPackage, resolveSdkPackage } from "./sdkPackageResolution.js";

/**
 * Regression teeth for the published-package SDK false-negative that Huaihuai
 * measured against the Raft daemon's real dependencies (2026-08-13).
 *
 * These build a REAL package on disk rather than stubbing the resolver,
 * because the bug lives in Node's resolution semantics: a package whose
 * `exports` map omits `./package.json` makes `require.resolve("pkg/package.json")`
 * throw ERR_PACKAGE_PATH_NOT_EXPORTED while the package is installed and
 * importable. A hand-written fake resolver could not reproduce that — it would
 * only reproduce my belief about it. Verified here first: the assertion below
 * that the OLD route throws that exact code is what makes the rest meaningful.
 *
 * Why this matters beyond a version string: canonical `kimi` is DEFINED as
 * "SDK present". A resolver false-negative is therefore not a missing version,
 * it is the runtime reporting itself not_installed on a host where it is
 * installed.
 */

const SDK_NAME = "@botiverse/kimi-code-sdk";
const SDK_VERSION = "3.2.1";

function makeExportsBlockedPackage(): { dir: string; entry: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "oar-sdk-resolve-"));
  const pkgRoot = join(dir, "node_modules", SDK_NAME);
  mkdirSync(join(pkgRoot, "dist"), { recursive: true });
  writeFileSync(
    join(pkgRoot, "package.json"),
    JSON.stringify({
      name: SDK_NAME,
      version: SDK_VERSION,
      type: "module",
      main: "./dist/index.mjs",
      // The whole point: "." is published, "./package.json" is NOT.
      exports: { ".": "./dist/index.mjs" },
    }),
  );
  writeFileSync(join(pkgRoot, "dist", "index.mjs"), 'export const marker = "kimi";\n');
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "consumer", type: "module" }));
  // A require rooted INSIDE the temp consumer — this is what "resolved from the
  // consumer's module position" means, and it is the position a published OAR
  // occupies once its optional peers are declared.
  const requireFromConsumer = createRequire(pathToFileURL(join(dir, "index.mjs")).href);
  return {
    dir,
    entry: requireFromConsumer.resolve(SDK_NAME),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("the OLD route really does fail on an exports-guarded package", () => {
  // This test exists to prove the defect is real before asserting the fix.
  // If a future SDK layout stops blocking ./package.json this goes green for a
  // new reason, and the fix teeth below would be guarding nothing — so the
  // failure mode is asserted explicitly, by error code, not by "it threw".
  const pkg = makeExportsBlockedPackage();
  try {
    const requireFromConsumer = createRequire(
      pathToFileURL(join(pkg.dir, "index.mjs")).href,
    );
    assert.throws(
      () => requireFromConsumer.resolve(`${SDK_NAME}/package.json`),
      (err: NodeJS.ErrnoException) => err.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
      "the subpath must be blocked, otherwise this fixture is not reproducing the bug",
    );
  } finally {
    pkg.cleanup();
  }
});

test("main-entry + walk-up reads the version the blocked subpath could not", () => {
  const pkg = makeExportsBlockedPackage();
  try {
    const resolved = resolveSdkPackage([SDK_NAME], () => pkg.entry);
    assert.ok(resolved, "installed SDK must resolve");
    assert.equal(resolved.name, SDK_NAME);
    assert.equal(resolved.version, SDK_VERSION);
    assert.equal(resolved.entry, pkg.entry);
    // root must be the package root, not the dist/ dir the entry lives in.
    assert.ok(resolved.root.endsWith("kimi-code-sdk"), `unexpected root ${resolved.root}`);
  } finally {
    pkg.cleanup();
  }
});

test("the DEFAULT resolver works on a real exports-guarded dependency", () => {
  // Every other test here injects an entry resolver, which means none of them
  // exercise defaultEntryResolver — the code that actually runs in production.
  // A mutation of the default path would have survived them all; that gap is
  // why this test exists.
  //
  // `commander` is oar's own runtime dependency and, measured here, blocks
  // ./package.json with the identical error code as the two SDKs — so it is a
  // faithful stand-in that is guaranteed installed wherever this suite runs
  // (the real SDKs are not).
  const requireHere = createRequire(import.meta.url);
  assert.throws(
    () => requireHere.resolve("commander/package.json"),
    (err: NodeJS.ErrnoException) => err.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
    "commander must still be exports-guarded, or it no longer stands in for the SDKs",
  );

  const resolved = resolveSdkPackage(["commander"]);
  assert.ok(resolved, "default resolver must find an installed, exports-guarded package");
  assert.equal(resolved.name, "commander");
  assert.match(resolved.version, /^\d+\.\d+/, `unexpected version ${resolved.version}`);
});

test("the default resolver finds an ESM-only package that CJS require cannot", () => {
  // Measured on the real @earendil-works/pi-coding-agent: BOTH `pkg/package.json`
  // AND `require.resolve(pkg)` throw ERR_PACKAGE_PATH_NOT_EXPORTED, because its
  // exports map publishes only an "import" condition. Only import.meta.resolve
  // sees it. So "ESM first, CJS fallback" is load-bearing ordering, not style —
  // a CJS-only resolver would leave pi reporting absent while installed.
  //
  // The fixture is written into oar's OWN node_modules because that is the only
  // position defaultEntryResolver looks from; node_modules is untracked, and the
  // directory is removed in finally.
  const oarNodeModules = join(fileURLToPath(new URL("../../../", import.meta.url)), "node_modules");
  const pkgName = "@oar-fixture/esm-only-probe";
  const pkgRoot = join(oarNodeModules, "@oar-fixture", "esm-only-probe");
  try {
    mkdirSync(join(pkgRoot, "dist"), { recursive: true });
    writeFileSync(
      join(pkgRoot, "package.json"),
      JSON.stringify({
        name: pkgName,
        version: "7.7.7",
        type: "module",
        // No "main", and only an "import" condition: this is pi's shape.
        exports: { ".": { import: "./dist/index.mjs" } },
      }),
    );
    writeFileSync(join(pkgRoot, "dist", "index.mjs"), "export const marker = 1;\n");

    // Precondition: CJS genuinely cannot see it, or this proves nothing.
    assert.throws(
      () => createRequire(import.meta.url).resolve(pkgName),
      "CJS require must not be able to resolve the ESM-only fixture",
    );

    const resolved = resolveSdkPackage([pkgName]);
    assert.ok(resolved, "ESM-first resolution must find the ESM-only package");
    assert.equal(resolved.version, "7.7.7");
  } finally {
    rmSync(join(oarNodeModules, "@oar-fixture"), { recursive: true, force: true });
  }
});

test("an unresolvable candidate yields null, not a throw", () => {
  // Absent must stay a value, not an exception: detect() turns null into
  // "not installed" and lets a throw become detect_failed, which is a
  // different product state.
  assert.equal(resolveSdkPackage(["@nope/not-installed"], () => null), null);
});

test("candidates are tried in order and the first installed one wins", () => {
  const pkg = makeExportsBlockedPackage();
  try {
    const resolved = resolveSdkPackage(
      ["@upstream/absent", SDK_NAME],
      (spec) => (spec === SDK_NAME ? pkg.entry : null),
    );
    assert.equal(resolved?.name, SDK_NAME);
    assert.equal(resolved?.version, SDK_VERSION);
  } finally {
    pkg.cleanup();
  }
});

test("walk-up will not accept a package.json whose name does not match", () => {
  // Guards the nested-dependency case: the entry can sit below an unrelated
  // package root. Matching on name is what stops us reporting the WRONG
  // package's version as the SDK's.
  const dir = mkdtempSync(join(tmpdir(), "oar-sdk-mismatch-"));
  try {
    mkdirSync(join(dir, "inner"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "@someone/other-package", version: "9.9.9" }),
    );
    const entry = join(dir, "inner", "index.mjs");
    writeFileSync(entry, "export default 1;\n");
    assert.equal(findOwningPackage(entry, SDK_NAME), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
