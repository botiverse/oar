import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire, findPackageJSON } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { downloadVerified, exactVersion, readManifest } from "./runtime-common.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(new URL("../../packages/oar/package.json", import.meta.url));

export function rewriteSdkManifests(group, packages, directory) {
  assert.ok(group === "pi" || group === "cursor", "Unknown SDK candidate group");
  for (const entry of Object.values(packages)) assert.ok(exactVersion(entry.version), "SDK candidate must be exact");
  for (const relative of ["package.json", "packages/oar/package.json", "packages/cli/package.json"]) {
    const file = path.join(directory, relative);
    const manifest = JSON.parse(readFileSync(file));
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (packages[name]) manifest[field][name] = packages[name].version;
        if (group === "pi" && name === "@earendil-works/pi-ai-durable") {
          manifest[field][name] = `npm:@earendil-works/pi-ai@${packages["@earendil-works/pi-ai"].version}`;
        }
      }
    }
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [group, file, ...extra] = process.argv.slice(2);
  assert.ok(group && file && extra.length === 0, "Usage: runtime-sdk-candidate.mjs <pi|cursor> <candidates.json>");
  const bytes = readFileSync(file);
  const candidates = JSON.parse(bytes);
  assert.equal(candidates.baselineSha256, readManifest().sha256, "SDK candidates belong to another baseline");
  const selected = candidates.sdks?.[group];
  assert.ok(selected?.packages, "Missing frozen SDK candidate set");
  const directory = path.resolve(process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run", "sdk-candidate");
  mkdirSync(directory, { recursive: true });
  const report = { group, candidateSha256: createHash("sha256").update(bytes).digest("hex"), packages: {}, status: "failed", stage: "download" };
  const save = () => writeFileSync(path.join(directory, `${group}.json`), `${JSON.stringify(report, null, 2)}\n`);
  save();
  try {
    for (const [name, entry] of Object.entries(selected.packages)) {
      report.packages[name] = { expectedVersion: entry.version, integrity: entry.dist.integrity, downloadAttempts: [] };
      await downloadVerified(entry.dist, { onAttempt: attempt => {
        report.packages[name].downloadAttempts[attempt.attempt - 1] = attempt;
        save();
      } });
      save();
    }
    rewriteSdkManifests(group, selected.packages, root);
    report.stage = "install";
    save();
    // Keep pnpm's normal supply-chain policy. A too-new or unavailable candidate
    // fails this daily run; it does not weaken the accepted workspace policy.
    const installed = require("cross-spawn").sync("pnpm", ["install", "--no-frozen-lockfile"], { cwd: root, stdio: "inherit", timeout: 300_000 });
    assert.ok(!installed.error && installed.status === 0, `Candidate SDK installation failed: ${installed.status}`);
    report.stage = "verify";
    for (const [name, entry] of Object.entries(selected.packages)) {
      const manifest = findPackageJSON(name, pathToFileURL(path.join(root, "package.json")));
      assert.ok(manifest, `Missing installed ${name}`);
      const actual = JSON.parse(readFileSync(manifest)).version;
      report.packages[name].actualVersion = actual;
      assert.equal(actual, entry.version, `Installed ${name} differs from the frozen candidate`);
    }
    report.status = "verified";
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally { save(); }
}
