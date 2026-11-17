/** Daily candidate gate. A retained --fake-responses flag does not imply a working reader. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { releaseVersion, versionAtLeast } from "../../packages/oar/src/shared/update.js";

const [command] = process.argv.slice(2);
assert.ok(command !== undefined, "usage: qoder-candidate.ts <qodercli executable>");
const readback = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 30_000 });
assert.equal(readback.status, 0, "Native version readback must succeed before selecting a probe");
const version = releaseVersion(readback.stdout);
assert.ok(version !== undefined, "Native version is unreadable; do not attempt replay");
if (versionAtLeast(version, "1.1.82")) {
  console.log(JSON.stringify({ version, status: "no_offline_replay_requires_real_account", submittedPrompts: 0 }));
} else {
  assert.equal(version, "1.1.81", "Only the retained replay baseline is selected by this daily probe");
  const env = { ...process.env, OAR_TEST: "qoder-native", OAR_TEST_REQUIRE_AVAILABLE: "1", OAR_QODER_BIN: resolve(command) };
  for (const args of [["--import", "tsx", "sea-trial/main.ts"], ["node_modules/vitest/vitest.mjs", "run", "sea-trial/vendor"]]) {
    const result = spawnSync(process.execPath, args, { env, stdio: "inherit", timeout: 600_000 });
    assert.equal(result.status, 0, "Native replay suite must pass");
  }
}
