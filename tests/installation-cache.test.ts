import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import type { InstallationProbe } from "../packages/oar/src/contracts/installation.js";
import { clearInstallationCache, executableInstallation } from "../packages/oar/src/shared/installation.js";

const dirs: string[] = [];
afterEach(async () => {
  clearInstallationCache();
  await Promise.all(dirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
});

/** A POSIX executable that answers --version and any readiness check, logging each start to `runs` beside it. */
async function fakeCli(dir: string, name: string, version: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, `#!/bin/sh\necho x >> ${JSON.stringify(path.join(dir, "runs"))}\n[ "$1" = "--version" ] && echo "${version}"\nexit 0\n`);
  await chmod(file, 0o755);
  return file;
}

async function runs(dir: string): Promise<number> {
  const text = await readFile(path.join(dir, "runs"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).length;
}

async function versionOf(probe: InstallationProbe): Promise<string | null> {
  const snapshot = await probe();
  return snapshot.kind === "available" && snapshot.via === "executable" ? snapshot.version ?? null : null;
}

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "oar-installation-cache-"));
  dirs.push(dir);
  return dir;
}

test.skipIf(process.platform === "win32")("an unchanged executable is not started again", async () => {
  const dir = await scratch();
  const probe = executableInstallation("OAR_FIXTURE_CACHE_BIN", await fakeCli(dir, "fake-cli", "1.0.0"), [], ["--help"]);
  assert.equal(await versionOf(probe), "1.0.0");
  assert.equal(await versionOf(probe), "1.0.0");
  // Readiness plus --version once; the second probe started nothing.
  assert.equal(await runs(dir), 2);
  clearInstallationCache();
  await probe();
  assert.equal(await runs(dir), 4);
});

test.skipIf(process.platform === "win32")("a replaced executable is probed again and reports its new version", async () => {
  const dir = await scratch();
  const cli = await fakeCli(dir, "fake-cli", "1.0.0");
  const probe = executableInstallation("OAR_FIXTURE_CACHE_BIN", cli);
  assert.equal(await versionOf(probe), "1.0.0");
  await rm(cli);
  await fakeCli(dir, "fake-cli", "2.0.0");
  assert.equal(await versionOf(probe), "2.0.0");
});

test.skipIf(process.platform === "win32")("version-manager shims are never cached", async () => {
  const shims = path.join(await scratch(), "shims");
  await mkdir(shims);
  const probe = executableInstallation("OAR_FIXTURE_CACHE_BIN", await fakeCli(shims, "fake-cli", "1.0.0"));
  await probe();
  await probe();
  assert.equal(await runs(shims), 2);
});

test.skipIf(process.platform === "win32")("a missing executable is never cached", async () => {
  const dir = await scratch();
  const later = executableInstallation("OAR_FIXTURE_CACHE_BIN", path.join(dir, "later-cli"));
  const before = await later();
  assert.equal(before.kind, "not_found");
  await fakeCli(dir, "later-cli", "3.0.0");
  assert.equal(await versionOf(later), "3.0.0");
});

test.skipIf(process.platform === "win32")("a different environment probes again", async () => {
  const dir = await scratch();
  const probe = executableInstallation("OAR_FIXTURE_CACHE_BIN", await fakeCli(dir, "fake-cli", "1.0.0"), [], ["--help"]);
  await probe({ env: { OAR_FIXTURE_HOME: "/a" } });
  await probe({ env: { OAR_FIXTURE_HOME: "/b" } });
  await probe({ env: { OAR_FIXTURE_HOME: "/a" } });
  assert.equal(await runs(dir), 4);
});
