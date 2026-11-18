import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "../../scripts/runtime-install.mjs";

const require = createRequire(new URL("../../../packages/oar/package.json", import.meta.url));
const spawnSync = require("cross-spawn").sync;
const fixtures = {};
const diagnostics = [];
const report = path.resolve("oar-trial-run/runtime-fixture-preparation.json");
mkdirSync(path.dirname(report), { recursive: true });
for (const [name, version] of [["matching", "1.2.3"], ["mismatching", "9.8.7"]]) {
  const directory = mkdtempSync(path.join(tmpdir(), "oar-runtime-fixture-"));
  try {
    const source = {
      "package.json": JSON.stringify({ name: "oar-ci-fixture", version: "1.2.3", bin: { "oar-ci-fixture": "cli.cjs" } }),
      "cli.cjs": `#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)});\n`,
    };
    const fixture = path.join(directory, "package");
    const home = path.join(directory, "home");
    mkdirSync(fixture); mkdirSync(home);
    for (const [file, text] of Object.entries(source)) writeFileSync(path.join(fixture, file), text);
    const started = performance.now();
    const packed = spawnSync("npm", ["pack", "--offline", "--ignore-scripts", "--update-notifier=false", "--pack-destination", directory, fixture], {
      env: isolatedEnvironment(home), encoding: "utf8", timeout: 30_000,
    });
    diagnostics.push({ name, elapsedMs: performance.now() - started, status: packed.status, signal: packed.signal,
      error: packed.error?.code ?? null, stdout: packed.stdout, stderr: packed.stderr });
    writeFileSync(report, JSON.stringify({ platform: process.platform, node: process.version, diagnostics }, null, 2) + "\n");
    assert.equal(packed.status, 0, `Fixture preparation failed; see ${report}`);
    const bytes = readFileSync(path.join(directory, "oar-ci-fixture-1.2.3.tgz"));
    fixtures[name] = { source, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`, tarballBase64: bytes.toString("base64") };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
// Publish the fixed inputs only after both real npm pack operations succeeded.
writeFileSync(new URL("packages.json", import.meta.url), JSON.stringify({ schemaVersion: 1, fixtures }, null, 2) + "\n");
console.log(`Prepared both runtime-install fixtures; diagnostics: ${report}`);
