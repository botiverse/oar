// Official agy CLI 1.5.0 archives from platform updater manifests, 2026-11-05.
// https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const archives = {
  "Linux-X64": {
    "url": "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.0-5269980577660928/linux-x64/cli_linux_x64.tar.gz",
    "sha512": "e6031f850929210705d8c2393a5665b82b8c3b19684a6d3c556cafa31f26f77acbf164dfee96ca84a5ae7670ac0cc238a974c981c517b269194bdccff271cbd5"
  },
  "macOS-ARM64": {
    "url": "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.0-5269980577660928/darwin-arm/cli_mac_arm64.tar.gz",
    "sha512": "833a0a18a418f70b9fb8b2b1a4c4dc571f1b168b5104aa30379463695946ccc0201cd48f9cfd30231eb668ae6d07efe1b49a619ccaa14f7ee2861f9e049ee2be"
  },
  "macOS-X64": {
    "url": "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.0-5269980577660928/darwin-x64/cli_mac_x64.tar.gz",
    "sha512": "00525e7fd227dd3dd258cf43a2f9adff73d6fe2afe5ca1c1fb1f0b0624cbd4af4b2891b8281868d4dc7c33b4f5f509e96d2e9d319657c56a147a55de5d411272"
  },
  "Windows-X64": {
    "url": "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.0-5269980577660928/windows-x64/cli_windows_x64.exe",
    "sha512": "9877ace806be37a3b8a8165ce1f61016d07955ec4306219051f90f4749a38727d61ef2d1a6441270684cea7fd2733c8a8524170ec9ff301b1b6a6b9c543d864e"
  }
};
const entry = archives[`${process.env.RUNNER_OS}-${process.env.RUNNER_ARCH}`];
assert.ok(entry, "No verified agy CLI archive for runner platform");
assert.ok(process.env.RUNNER_TEMP && process.env.GITHUB_ENV, "Expected GitHub runner paths");
const destination = path.join(process.env.RUNNER_TEMP, "oar-agy-cli-1.5.0");
mkdirSync(destination, { recursive: true });
const archive = path.join(destination, "download");
const response = await fetch(entry.url, { signal: AbortSignal.timeout(120_000) });
assert.equal(response.status, 200, `agy CLI download: HTTP ${response.status}`);
const content = Buffer.from(await response.arrayBuffer());
assert.equal(createHash("sha512").update(content).digest("hex"), entry.sha512, "agy CLI archive digest mismatch");
writeFileSync(archive, content);
let binary;
if (process.platform === "win32") {
  binary = path.join(destination, "agy.exe");
  renameSync(archive, binary);
} else {
  execFileSync("tar", ["-xzf", archive, "-C", destination]);
  const candidates = readdirSync(destination, { recursive: true }).filter((file) => path.basename(file) === "antigravity");
  assert.equal(candidates.length, 1, "Expected one agy CLI executable");
  binary = path.join(destination, candidates[0]);
  chmodSync(binary, 0o755);
}
const version = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 30_000 }).trim();
assert.equal(version, "1.5.0");
assert.ok(!/[\r\n]/u.test(binary), "Expected a single-line executable path");
appendFileSync(process.env.GITHUB_ENV, `OAR_ANTIGRAVITY_BIN=${binary}\n`);
process.stdout.write("Verified agy CLI 1.5.0\n");
