import assert from "node:assert/strict";
import { npmSpec, readManifest, runtimePin } from "./runtime-common.mjs";

// Emit only an exact npm package spec on stdout, for the workflow to install.
// Resolve beside this script so the caller's working directory cannot select pins.
try {
  const [backend, ...extra] = process.argv.slice(2);
  assert.ok(backend && extra.length === 0, "Usage: runtime-version.mjs <backend>");
  const { manifest } = readManifest();
  process.stdout.write(`${npmSpec(runtimePin(manifest, backend), backend)}\n`);
} catch (error) {
  process.stderr.write(`Cannot read accepted CI runtime version: ${error.message}\n`);
  process.exitCode = 1;
}
