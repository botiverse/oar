/** Copy a caller-supplied old official agy into a disposable HOME and exercise OAR's upgrade path. */
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { antigravityRuntime } from "../../packages/oar/src/runtimes/antigravity/index.js";

const [source] = process.argv.slice(2);
assert.ok(source !== undefined && source.length > 0, "usage: pnpm tsx experiments/old-cli-upgrade/antigravity.ts /path/to/old/agy");
const home = mkdtempSync(path.join(tmpdir(), "oar-old-agy-"));
const command = path.join(home, ".local", "bin", process.platform === "win32" ? "agy.exe" : "agy");
mkdirSync(path.dirname(command), { recursive: true });
copyFileSync(path.resolve(source), command);
// This standalone probe never inherits login/configuration or changes the caller's installation.
for (const name of Object.keys(process.env)) {
  if (!["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG"].includes(name)) { delete process.env[name]; }
}
Object.assign(process.env, {
  HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, "config"),
  XDG_CACHE_HOME: path.join(home, "cache"), XDG_DATA_HOME: path.join(home, "data"), OAR_ANTIGRAVITY_BIN: command,
});
try {
  const before = await antigravityRuntime.installation();
  assert.equal(before.kind, "unsupported");
  assert.equal(before.code, "version_unsupported");
  assert.equal(before.command, command);
  const check = await antigravityRuntime.checkUpdate(before);
  const upgrade = await antigravityRuntime.upgrade(before, { timeoutMs: 180_000 });
  const after = await antigravityRuntime.installation();
  const result = { platform: process.platform, arch: process.arch,
    before: { ...before, command: "<isolated>/agy", reason: before.reason.replaceAll(command, "<isolated>/agy") }, check, upgrade,
    after: after.kind === "available" && after.via === "executable" ? { ...after, command: "<isolated>/agy" } : after };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  assert.equal(upgrade.kind, "upgraded");
  assert.equal(after.kind, "available");
} finally { rmSync(home, { recursive: true, force: true }); }
