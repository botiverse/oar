/* oxlint-disable max-statements -- Integration checks with temporary scripts and loopback HTTP server. */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import {
  isStandalonePiCommand,
  piInstallationFor,
  piInstalledExecutableCandidates,
} from "../../packages/oar/src/runtimes/pi/installation.js";
import { createPiInstall, createPiInstallPlan, piInstallPlan } from "../../packages/oar/src/runtimes/pi/install.js";
import { piUpdateCheck, piUpgrade } from "../../packages/oar/src/runtimes/pi/update.js";
import { clearInstallationCache } from "../../packages/oar/src/shared/installation.js";
import { fakeAgentBinary } from "../fixtures/process-tree.js";
import { startReleaseServer } from "../fixtures/update-fixtures.js";

const scratch = mkdtempSync(path.join(tmpdir(), "oar-pi-external-"));
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });
afterEach(() => { clearInstallationCache(); vi.unstubAllEnvs(); });

const healthyHost = {
  compiledSingleExecutable: false,
  electron: false,
  resolveModule: (specifier: string) => `/resolved/${specifier}`,
};

function makeFakePi(dir: string, version: string, prefixArg?: string): string {
  mkdirSync(dir, { recursive: true });
  const script = path.join(dir, `pi-${version}.mjs`);
  const guard = prefixArg === undefined ? "" : `if (process.argv[2] !== ${JSON.stringify(prefixArg)}) process.exit(2);`;
  writeFileSync(script, [
    guard,
    `if (process.argv.includes("--version")) { process.stdout.write(${JSON.stringify(`${version}\n`)}); process.exit(0); }`,
    "process.exit(0);",
  ].join("\n"));
  if (process.platform === "win32") {
    return fakeAgentBinary(dir, [script]);
  }
  const bin = path.join(dir, "pi");
  writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

test("isStandalonePiCommand matches only execution: subprocess, command: pi, and omitted args", () => {
  expect(isStandalonePiCommand({})).toBe(false);
  expect(isStandalonePiCommand({ execution: "subprocess" })).toBe(false);
  expect(isStandalonePiCommand({ execution: "subprocess", command: "pi" })).toBe(true);
  expect(isStandalonePiCommand({ execution: "subprocess", command: "/usr/local/bin/pi" })).toBe(false);
  expect(isStandalonePiCommand({ execution: "subprocess", command: "pi", args: ["sub"] })).toBe(false);
  expect(isStandalonePiCommand({ execution: "subprocess", command: "pi", args: [] })).toBe(false);
});

test("piInstalledExecutableCandidates resolves agent dir overrides on POSIX and Windows", () => {
  expect(piInstalledExecutableCandidates("linux", "/home/alice", {})).toEqual([
    "/home/alice/.local/bin/pi",
    "/home/alice/.pi/agent/install/pi",
    "/home/alice/.pi/agent/install/bin/pi",
  ]);
  expect(piInstalledExecutableCandidates("linux", "/home/alice", { OAR_PI_AGENT_DIR: "/custom/agent" })).toEqual([
    "/home/alice/.local/bin/pi",
    "/custom/agent/install/pi",
    "/custom/agent/install/bin/pi",
  ]);
  expect(piInstalledExecutableCandidates("win32", String.raw`C:\Users\alice`, { PI_CODING_AGENT_DIR: String.raw`D:\pi-agent` })).toEqual([
    String.raw`C:\Users\alice\.local\bin\pi.cmd`,
    String.raw`C:\Users\alice\.local\bin\pi.exe`,
    String.raw`D:\pi-agent\install\pi.cmd`,
    String.raw`D:\pi-agent\install\pi.exe`,
    String.raw`D:\pi-agent\install\bin\pi.cmd`,
    String.raw`D:\pi-agent\install\bin\pi.exe`,
  ]);
  expect(piInstalledExecutableCandidates("win32", undefined, { USERPROFILE: String.raw`C:\Users\bob` })[0]).toBe(
    String.raw`C:\Users\bob\.local\bin\pi.cmd`,
  );
});

test.skipIf(process.platform === "win32")("standalone command: pi finds off-PATH ~/.local/bin and npm global prefix copies", async () => {
  const home = mkdtempSync(path.join(scratch, "off-path-"));
  const localPi = makeFakePi(path.join(home, ".local", "bin"), "1.6.1");
  const probe = piInstallationFor({ execution: "subprocess", command: "pi" }, healthyHost);
  await expect(probe({ env: { HOME: home, PATH: "", OAR_PI_AGENT_DIR: null, PI_CODING_AGENT_DIR: null } })).resolves.toEqual({
    kind: "available",
    via: "executable",
    command: localPi,
    version: "1.6.1",
  });

  const npmHome = mkdtempSync(path.join(scratch, "npm-fallback-"));
  const npmPrefix = path.join(npmHome, "npm-global");
  const npmBinDir = path.join(npmHome, "tool-bin");
  mkdirSync(npmBinDir, { recursive: true });
  const npmPi = makeFakePi(path.join(npmPrefix, "bin"), "1.6.0");
  const npmCmd = path.join(npmBinDir, "npm");
  writeFileSync(npmCmd, `#!/bin/sh\nif [ "$1" = "prefix" ] && [ "$2" = "-g" ]; then printf '%s\\n' ${JSON.stringify(npmPrefix)}; exit 0; fi\nexit 1\n`);
  chmodSync(npmCmd, 0o755);
  await expect(probe({ env: { HOME: npmHome, PATH: npmBinDir, OAR_PI_AGENT_DIR: null, PI_CODING_AGENT_DIR: null } })).resolves.toEqual({
    kind: "available",
    via: "executable",
    command: npmPi,
    version: "1.6.0",
  });

  const shadowRoot = mkdtempSync(path.join(scratch, "shadow-"));
  const primaryPi = makeFakePi(path.join(shadowRoot, "first"), "1.6.1");
  const secondaryPi = makeFakePi(path.join(shadowRoot, "second"), "1.6.0");
  await expect(probe({
    env: { HOME: shadowRoot, PATH: [path.dirname(primaryPi), path.dirname(secondaryPi)].join(path.delimiter), OAR_PI_AGENT_DIR: null, PI_CODING_AGENT_DIR: null },
  })).resolves.toEqual({
    kind: "available",
    via: "executable",
    command: primaryPi,
    version: "1.6.1",
    shadowed: [secondaryPi],
  });
});

test("piInstallPlan uses npm install -g --ignore-scripts on @earendil-works/pi-coding-agent", async () => {
  const dir = mkdtempSync(path.join(scratch, "install-plan-"));
  const prefix = path.join(dir, "prefix");
  mkdirSync(path.join(prefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent"), { recursive: true });
  mkdirSync(path.join(prefix, "bin"), { recursive: true });
  if (process.platform === "win32") {
    const plan = await piInstallPlan();
    expect(["plan", "unsupported"]).toContain(plan.kind);
  } else {
    const origPath = process.env.PATH;
    const origPrefix = process.env.npm_config_prefix;
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    const fakeNpm = path.join(binDir, "npm");
    writeFileSync(fakeNpm, `#!/bin/sh\nif [ "$1" = "prefix" ]; then printf '%s\\n' ${JSON.stringify(prefix)}; exit 0; fi\nexit 1\n`);
    chmodSync(fakeNpm, 0o755);
    process.env.PATH = binDir;
    process.env.npm_config_prefix = prefix;
    try {
      const plan = await piInstallPlan();
      expect(plan).toEqual({
        kind: "plan",
        steps: [{ command: ["npm", "install", "-g", "--ignore-scripts", "@earendil-works/pi-coding-agent"], display: "npm install -g --ignore-scripts @earendil-works/pi-coding-agent" }],
        source: "https://github.com/earendil-works/pi#getting-started",
        network: true,
        privileges: false,
      });
    } finally {
      if (origPath === undefined) { delete process.env.PATH; } else { process.env.PATH = origPath; }
      if (origPrefix === undefined) { delete process.env.npm_config_prefix; } else { process.env.npm_config_prefix = origPrefix; }
    }
  }
});

function makeUpgradeFakePi(dir: string) {
  const logFile = path.join(dir, "args.log");
  const versionFile = path.join(dir, "version.txt");
  writeFileSync(versionFile, "1.6.1");
  const script = path.join(dir, "fake-pi.mjs");
  writeFileSync(script, [
    "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
    `appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    String.raw`if (process.argv.includes('--version')) { process.stdout.write(readFileSync(${JSON.stringify(versionFile)}, 'utf8') + '\n'); process.exit(0); }`,
    `if (process.argv.slice(2).join(' ') === 'update --self --no-approve') {`,
    `  if (readFileSync(${JSON.stringify(versionFile)}, 'utf8').trim() === 'fail') { process.exit(1); }`,
    `  writeFileSync(${JSON.stringify(versionFile)}, '1.6.1'); process.exit(0);`,
    "}",
    "process.exit(1);",
  ].join("\n"));
  return { command: fakeAgentBinary(dir, [script]), logFile, versionFile };
}

test("createPiInstallPlan and createPiInstall guard unsupported and available selections", async () => {
  await expect(createPiInstallPlan(async () => ({
    kind: "unsupported", code: "dependency_missing", reason: "missing",
  }))({ line: "v2" })).resolves.toMatchObject({ kind: "unsupported", reason: "unknown_line" });

  await expect(createPiInstallPlan(async () => ({
    kind: "unsupported", code: "dependency_missing", reason: "Pi RPC requires @earendil-works/pi-coding-agent",
  }))()).resolves.toEqual({ kind: "unsupported", reason: "configuration", detail: "Pi RPC requires @earendil-works/pi-coding-agent" });

  await expect(createPiInstallPlan(async () => ({
    kind: "unsupported", code: "version_unsupported", via: "executable", command: "/bin/pi", reason: "too old", installedVersion: "1.3.0", requiredVersion: "1.4.0",
  }))()).resolves.toEqual({
    kind: "unsupported", reason: "configuration", detail: "too old. Installing via npm does not replace this existing selection; upgrade or remove it before installing.",
  });

  await expect(createPiInstall(async () => ({ kind: "available", via: "executable", command: "/bin/pi", version: "1.6.1" }))()).resolves.toEqual({
    kind: "already_installed", installation: { kind: "available", via: "executable", command: "/bin/pi", version: "1.6.1" },
  });
});

test.skipIf(process.platform === "win32")("createPiInstall installs pi into npm global prefix and finds it on re-probe", async () => {
  const home = mkdtempSync(path.join(scratch, "install-flow-"));
  const prefix = path.join(home, "npm-global");
  const binDir = path.join(home, "tools");
  const installedBin = path.join(prefix, "bin", "pi");
  mkdirSync(path.join(prefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent"), { recursive: true });
  mkdirSync(path.join(prefix, "bin"), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const fakePiScript = path.join(home, "fake-pi.mjs");
  writeFileSync(fakePiScript, String.raw`process.stdout.write("1.6.1\n");`);
  const fakeNpm = path.join(binDir, "npm");
  writeFileSync(fakeNpm, [
    `#!${process.execPath}`,
    'const { chmodSync, writeFileSync } = require("node:fs");',
    `if (process.argv[2] === "prefix") { process.stdout.write(${JSON.stringify(`${prefix}\n`)}); process.exit(0); }`,
    'if (process.argv[2] === "install") {',
    `  writeFileSync(${JSON.stringify(installedBin)}, "#!/bin/sh\\nexec " + ${JSON.stringify(process.execPath)} + " " + ${JSON.stringify(fakePiScript)} + "\\n");`,
    `  chmodSync(${JSON.stringify(installedBin)}, 0o755); process.exit(0);`,
    "}",
    "process.exit(1);",
  ].join("\n"));
  chmodSync(fakeNpm, 0o755);
  vi.stubEnv("HOME", home);
  vi.stubEnv("PATH", binDir);
  vi.stubEnv("npm_config_prefix", prefix);
  vi.stubEnv("OAR_PI_AGENT_DIR", "");
  vi.stubEnv("PI_CODING_AGENT_DIR", "");
  const install = createPiInstall(piInstallationFor({ execution: "subprocess", command: "pi" }, healthyHost));
  await expect(install()).resolves.toMatchObject({ kind: "installed", installation: { kind: "available", via: "executable", command: installedBin, version: "1.6.1" } });
});

test("piUpdateCheck parses pi.dev release JSON, handles ok:false and prereleases, and refuses bundled", async () => {
  await expect(piUpdateCheck("http://127.0.0.1:1")({ kind: "available", via: "bundled" })).resolves.toEqual({
    kind: "unavailable", reason: "unsupported_installation", detail: "an in-process SDK; it moves with the package that carries it",
  });
  const server = await startReleaseServer();
  try {
    const url = `${server.base}/api/latest-version`;
    server.routes.set("/api/latest-version", [200, JSON.stringify({ ok: true, version: "1.6.1", packageName: "@earendil-works/pi-coding-agent" })]);
    const check = piUpdateCheck(url);
    await expect(check({ kind: "available", via: "executable", command: "/bin/pi", version: "1.5.2" })).resolves.toEqual({ kind: "ok", installed: "1.5.2", latest: "1.6.1", updateAvailable: true, source: url });
    await expect(check({ kind: "unsupported", code: "version_unsupported", via: "executable", command: "/bin/pi", reason: "old", installedVersion: "1.3.0", requiredVersion: "1.4.0" })).resolves.toEqual({ kind: "ok", installed: "1.3.0", latest: "1.6.1", updateAvailable: true, source: url });
    await expect(check({ kind: "unsupported", code: "version_unsupported", via: "executable", command: "/bin/pi", reason: "pre", installedVersion: "1.6.1-rc.1", requiredVersion: "1.4.0" })).resolves.toEqual({ kind: "ok", installed: "1.6.1-rc.1", latest: "1.6.1", updateAvailable: true, source: url });
    await expect(check({ kind: "available", via: "executable", command: "/bin/pi", version: "1.6.2" })).resolves.toEqual({ kind: "ok", installed: "1.6.2", latest: "1.6.1", updateAvailable: false, source: url });
    server.routes.set("/api/latest-version", [200, JSON.stringify({ ok: false, error: "maintenance" })]);
    await expect(check({ kind: "available", via: "executable", command: "/bin/pi", version: "1.6.1" })).resolves.toEqual({ kind: "unavailable", reason: "lookup_failed", detail: "maintenance", source: url });
    server.routes.set("/api/latest-version", [503, "unavailable"]);
    await expect(check({ kind: "available", via: "executable", command: "/bin/pi", version: "1.6.1" })).resolves.toEqual({ kind: "unavailable", reason: "lookup_failed", detail: "HTTP 503", source: url });
  } finally { server.close(); }
});

test("piUpgrade refuses bundled and skips updater when current", async () => {
  await expect(piUpgrade({ kind: "available", via: "bundled" })).resolves.toEqual({
    kind: "unsupported", reason: "unsupported_installation", detail: "an in-process SDK; it moves with the package that carries it",
  });
  const fake = makeUpgradeFakePi(mkdtempSync(path.join(scratch, "upgrade-current-")));
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ ok: true, version: "1.6.1" }, { status: 200 });
  try {
    await expect(piUpgrade({ kind: "available", via: "executable", command: fake.command, version: "1.6.1" })).resolves.toEqual({
      kind: "current", version: "1.6.1",
      check: { kind: "ok", installed: "1.6.1", latest: "1.6.1", updateAvailable: false, source: "https://pi.dev/api/latest-version" },
    });
    expect(readFileSync(fake.logFile, "utf8").trim().split("\n")).toEqual([JSON.stringify(["--version"])]);
  } finally { globalThis.fetch = origFetch; }
});

test("piUpgrade invokes update --self --no-approve on upgrades and failures", async () => {
  const fake = makeUpgradeFakePi(mkdtempSync(path.join(scratch, "upgrade-run-")));
  const origFetch = globalThis.fetch;
  let remoteVersion = "1.6.1";
  globalThis.fetch = async () => Response.json({ ok: true, version: remoteVersion }, { status: 200 });
  try {
    writeFileSync(fake.versionFile, "1.5.2");
    await expect(piUpgrade({ kind: "available", via: "executable", command: fake.command, version: "1.5.2" })).resolves.toMatchObject({ kind: "upgraded", from: "1.5.2", to: "1.6.1" });
    writeFileSync(fake.versionFile, "fail");
    remoteVersion = "1.7.0";
    expect(await piUpgrade({ kind: "available", via: "executable", command: fake.command, version: "1.6.1" })).toMatchObject({ kind: "failed", exitCode: 1 });
    expect(readFileSync(fake.logFile, "utf8").trim().split("\n")).toEqual([
      ["--version"], ["update", "--self", "--no-approve"], ["--version"],
      ["--version"], ["update", "--self", "--no-approve"], ["--version"],
    ].map((args) => JSON.stringify(args)));
  } finally { globalThis.fetch = origFetch; }
});
