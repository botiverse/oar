/** Install the official CLI in an empty HOME, with its bin off PATH, without touching a real login. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { antigravityInstallation } from "../packages/oar/src/runtimes/antigravity/installation.js";
import { antigravityInstall } from "../packages/oar/src/runtimes/antigravity/install.js";

if (process.argv.includes("--child")) {
  assert.deepEqual(await antigravityInstallation(), { kind: "not_found" });
  const first = await antigravityInstall();
  assert.equal(first.kind, "installed", JSON.stringify(first));
  const second = await antigravityInstall();
  assert.equal(second.kind, "already_installed", JSON.stringify(second));
  console.log(JSON.stringify({ first, second }));
} else {
  assert.notEqual(process.platform, "win32", "The shell installer is only run on Linux and macOS");
  const home = await mkdtemp(path.join(tmpdir(), "oar-agy-install-"));
  try {
    const child = spawn(process.execPath, ["--import", "tsx", import.meta.filename, "--child"], {
      stdio: "inherit", env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, SHELL: "/bin/bash",
        XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"),
        AGY_CLI_DISABLE_AUTO_UPDATE: "1",
      },
    });
    const exit: readonly unknown[] = await once(child, "exit");
    const [code] = exit;
    assert.equal(code, 0);
  } finally { await rm(home, { recursive: true, force: true }); }
}
