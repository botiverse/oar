import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Emit only an exact npm package spec on stdout, for the workflow to install.
// Resolve beside this script so the caller's working directory cannot select pins.
try {
  const [backend, ...extra] = process.argv.slice(2);
  assert.ok(backend && extra.length === 0, "Usage: runtime-version.mjs <backend>");
  const manifest = JSON.parse(readFileSync(new URL("../runtime-versions.json", import.meta.url), "utf8"));
  assert.equal(manifest?.schemaVersion, 1, "Unsupported runtime-versions.json schemaVersion");
  const runtimes = manifest.runtimes;
  assert.ok(runtimes && typeof runtimes === "object" && !Array.isArray(runtimes), "Missing runtime pins");
  assert.ok(Object.hasOwn(runtimes, backend), `No accepted runtime pin for ${backend}`);
  const entry = runtimes[backend];
  assert.ok(entry && typeof entry === "object" && !Array.isArray(entry), `Invalid runtime pin for ${backend}`);
  assert.ok(typeof entry.package === "string" && entry.package.trim() === entry.package
    && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(entry.package),
    `Expected an npm package name for ${backend}`);
  const number = "(?:0|[1-9][0-9]*)";
  const prerelease = `(?:${number}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
  const exactVersion = new RegExp(`^${number}\\.${number}\\.${number}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`, "u");
  assert.ok(typeof entry.version === "string" && entry.version.trim() === entry.version && exactVersion.test(entry.version),
    `Expected an exact npm version for ${backend}`);
  process.stdout.write(`${entry.package}@${entry.version}\n`);
} catch (error) {
  process.stderr.write(`Cannot read accepted CI runtime version: ${error.message}\n`);
  process.exitCode = 1;
}
