/* oxlint-disable eslint/max-statements, eslint/max-lines-per-function -- Each test verifies end-to-end PI_PACKAGE_DIR isolation across one Pi subprocess entry point. */
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createPiRuntime } from "../../packages/oar/src/runtimes/pi/index.js";
import { piUpgrade } from "../../packages/oar/src/runtimes/pi/update.js";
import { clearInstallationCache } from "../../packages/oar/src/shared/installation.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clearInstallationCache();
  await Promise.all(tempDirs.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }); }));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeFakePi(dir: string, nativeVersion: string, upgradeTo?: string): Promise<string> {
  const script = path.join(dir, "fake-pi.mjs");
  const versionFile = path.join(dir, "version.txt");
  await writeFile(versionFile, nativeVersion, "utf8");
  const source = [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "import path from 'node:path';",
    `const versionFile = ${JSON.stringify(versionFile)};`,
    `const upgradeTo = ${JSON.stringify(upgradeTo ?? null)};`,
    "const args = process.argv.slice(2);",
    "if (args.includes('--version')) {",
    "  const pkgDir = process.env.PI_PACKAGE_DIR;",
    "  if (pkgDir) {",
    "    const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));",
    "    console.log(pkg.version);",
    "  } else {",
    "    console.log(readFileSync(versionFile, 'utf8').trim());",
    "  }",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'update') {",
    "  if (process.env.PI_PACKAGE_DIR) { console.error('inherited PI_PACKAGE_DIR'); process.exit(1); }",
    "  if (upgradeTo !== null) { writeFileSync(versionFile, upgradeTo, 'utf8'); }",
    "  console.log('updated');",
    "  process.exit(0);",
    "}",
  ].join("\n");
  await writeFile(script, source, "utf8");
  if (process.platform === "win32") {
    const cmd = path.join(dir, "pi.cmd");
    await writeFile(cmd, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, "utf8");
    return cmd;
  }
  const bin = path.join(dir, "pi");
  await writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, "utf8");
  await chmod(bin, 0o755);
  return bin;
}

test("pi installation probe strips inherited PI_PACKAGE_DIR by default but honors an explicit env override", async () => {
  const dir = await makeTempDir("oar-pi-pkgdir-");
  const hostPkg = path.join(dir, "host-sea-pkg");
  const customPkg = path.join(dir, "custom-pkg");
  await mkdir(hostPkg, { recursive: true });
  await mkdir(customPkg, { recursive: true });
  await writeFile(path.join(hostPkg, "package.json"), JSON.stringify({ name: "host-sea", version: "1.25.9" }), "utf8");
  await writeFile(path.join(customPkg, "package.json"), JSON.stringify({ name: "nix-pi", version: "1.6.2" }), "utf8");

  await mkdir(path.join(dir, "old-bin"), { recursive: true });
  const oldPi = await writeFakePi(path.join(dir, "old-bin"), "0.84.2");
  await mkdir(path.join(dir, "new-bin"), { recursive: true });
  const newPi = await writeFakePi(path.join(dir, "new-bin"), "1.7.0");
  vi.stubEnv("PI_PACKAGE_DIR", hostPkg);

  // An old binary must not bypass the 1.4.0 floor via host PI_PACKAGE_DIR.
  const oldRuntime = createPiRuntime({ execution: "subprocess", command: oldPi });
  const oldSnapshot = await oldRuntime.installation();
  expect(oldSnapshot).toMatchObject({ kind: "unsupported", code: "version_unsupported", installedVersion: "0.84.2", requiredVersion: "1.4.0" });

  // A supported binary reports its own version, not the host package version.
  const newRuntime = createPiRuntime({ execution: "subprocess", command: newPi });
  const defaultSnapshot = await newRuntime.installation();
  expect(defaultSnapshot).toMatchObject({ kind: "available", via: "executable", version: "1.7.0" });

  // An explicit caller-supplied PI_PACKAGE_DIR is still honored.
  const explicitSnapshot = await newRuntime.installation({ env: { PI_PACKAGE_DIR: customPkg } });
  expect(explicitSnapshot).toMatchObject({ kind: "available", via: "executable", version: "1.6.2" });
});

test("bundled Pi RPC session opens cleanly when host process inherits PI_PACKAGE_DIR", async () => {
  const dir = await makeTempDir("oar-pi-bundled-pkgdir-");
  const hostPkg = path.join(dir, "host-sea-pkg");
  const agentDir = path.join(dir, "agent");
  await mkdir(hostPkg, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(hostPkg, "package.json"), JSON.stringify({ name: "host-sea", version: "1.25.9" }), "utf8");
  vi.stubEnv("PI_PACKAGE_DIR", hostPkg);

  const runtime = createPiRuntime({ execution: "subprocess" });
  const installation = await runtime.installation();
  expect(installation).toEqual({ kind: "available", via: "bundled" });
  if (installation.kind !== "available") { return; }

  const session = await runtime.session(installation, { cwd: dir, env: { HOME: dir, USERPROFILE: dir, PI_CODING_AGENT_DIR: agentDir } });
  try {
    expect(session.id).toBeTruthy();
  } finally {
    await session.dispose();
  }
}, 20_000);

test("piUpgrade strips inherited PI_PACKAGE_DIR during before/after version checks and updater execution", async () => {
  const dir = await makeTempDir("oar-pi-upgrade-pkgdir-");
  const hostPkg = path.join(dir, "host-sea-pkg");
  await mkdir(hostPkg, { recursive: true });
  await writeFile(path.join(hostPkg, "package.json"), JSON.stringify({ name: "host-sea", version: "1.25.9" }), "utf8");
  const piBin = await writeFakePi(dir, "1.6.0", "1.7.0");
  vi.stubEnv("PI_PACKAGE_DIR", hostPkg);
  vi.stubGlobal("fetch", vi.fn(async () => {
    await Promise.resolve();
    return Response.json({ ok: true, version: "1.7.0" }, { status: 200 });
  }));

  const upgraded = await piUpgrade({ kind: "available", via: "executable", command: piBin, version: "1.6.0" });
  expect(upgraded).toMatchObject({ kind: "upgraded", from: "1.6.0", to: "1.7.0" });
});
