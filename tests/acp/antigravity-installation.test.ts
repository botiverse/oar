/* oxlint-disable eslint/max-statements -- Each migration control keeps the discovered executable, plan and execution assertions together. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { antigravityInstall, antigravityInstallPlan } from "../../packages/oar/src/runtimes/antigravity/install.js";
import { afterEach, expect, test, vi } from "vitest";
import type { ExecutableRunner } from "../../packages/oar/src/shared/executable/run.js";
import { antigravityInstallation, antigravityInstalledExecutableCandidates, readAntigravityVersion } from "../../packages/oar/src/runtimes/antigravity/installation.js";
import { antigravityReleaseSource } from "../../packages/oar/src/runtimes/antigravity/update.js";

const runExecutable = vi.hoisted(() => vi.fn<ExecutableRunner>());
vi.mock("../../packages/oar/src/shared/executable/run.js", () => ({ runExecutable }));
afterEach(() => { runExecutable.mockReset(); vi.unstubAllEnvs(); });

test.each([
  ["1.5.0\n", "available"],
  ["1.4.9\n", "unsupported"],
  ["1.5.0-beta.1\n", "unsupported"],
  ["Update available\n1.5.0\n", "unsupported"],
  ["1.5.0\n1.6.0\n", "unsupported"],
  ["1.107.0\n0123456789abcdef0123456789abcdef01234567\nx64\n", "unsupported"],
  ["Build label: 1.4.5\n", "unsupported"],
])("native ACP requires the CLI version, not a successful unknown-command help: %j", async (stdout, kind) => {
  vi.stubEnv("OAR_ANTIGRAVITY_BIN", process.execPath);
  runExecutable.mockResolvedValue({ ok: true, exitCode: 0, stdout, stderr: "" });
  const result = await antigravityInstallation();
  expect(result.kind).toBe(kind);
  if (result.kind === "unsupported") { expect(result.reason).toContain(process.execPath); }
  expect(runExecutable).toHaveBeenCalledExactlyOnceWith(process.execPath, ["--version"], { timeoutMs: 30_000, env: process.env });
});

test("off-PATH discovery follows the official POSIX and Windows install directories", () => {
  expect(antigravityInstalledExecutableCandidates("linux", "/home/alice", {})).toEqual(["/home/alice/.local/bin/agy"]);
  expect(antigravityInstalledExecutableCandidates("darwin", "/Users/alice", {})).toEqual(["/Users/alice/.local/bin/agy"]);
  expect(antigravityInstalledExecutableCandidates("win32", String.raw`C:\Users\alice`, { LocalAppData: "D:\\AppData" })).toEqual([String.raw`D:\AppData\agy\bin\agy.exe`]);
  expect(antigravityInstalledExecutableCandidates("win32", String.raw`C:\Users\alice`, { LOCALAPPDATA: "" })).toEqual([String.raw`C:\Users\alice\AppData\Local\agy\bin\agy.exe`]);
});

test("update manifests follow the CLI's platform and architecture, including Linux musl", () => {
  const base = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/";
  expect(antigravityReleaseSource("linux", "x64")).toBe(`${base}linux_amd64.json`);
  expect(antigravityReleaseSource("linux", "arm64", true)).toBe(`${base}linux_arm64_musl.json`);
  expect(antigravityReleaseSource("darwin", "arm64")).toBe(`${base}darwin_arm64.json`);
  expect(antigravityReleaseSource("win32", "x64")).toBe(`${base}windows_amd64.json`);
  expect(antigravityReleaseSource("freebsd", "x64")).toBeUndefined();
  expect(antigravityReleaseSource("linux", "ia32")).toBeUndefined();
});

function scratchCli(home: string, directory: string, version: string): string {
  const bin = path.join(home, directory);
  mkdirSync(bin, { recursive: true });
  const file = path.join(bin, process.platform === "win32" ? "agy.exe" : "agy");
  writeFileSync(file, version, { mode: 0o755 });
  return file;
}
function isolatedHome(home: string): void {
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("LOCALAPPDATA", path.join(home, "local"));
  vi.stubEnv("OAR_ANTIGRAVITY_BIN", "");
}
const officialDirectory = process.platform === "win32" ? "local/agy/bin" : ".local/bin";

test("a supported official install is selected behind an older PATH copy", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "oar-agy-discovery-"));
  try {
    isolatedHome(home);
    const old = scratchCli(home, "old", "1.4.9");
    const current = scratchCli(home, officialDirectory, "1.5.0");
    vi.stubEnv("PATH", path.dirname(old));
    runExecutable.mockImplementation(async (command) => ({ ok: true, exitCode: 0, stdout: command === current ? "1.5.0" : "1.4.9", stderr: "" }));
    expect(await antigravityInstallation()).toMatchObject({ kind: "available", command: current, version: "1.5.0" });
    expect(await antigravityInstall()).toMatchObject({ kind: "already_installed", installation: { command: current } });
    expect(runExecutable.mock.calls.every(([, args]) => JSON.stringify(args) === '["--version"]')).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test.each(["official-old", "pinned-old-server", "pinned-missing"])("migration preflight refuses without running the installer: %s", async (scenario) => {
  const home = mkdtempSync(path.join(tmpdir(), "oar-agy-migration-"));
  try {
    isolatedHome(home);
    const old = scratchCli(home, officialDirectory, "old");
    vi.stubEnv("PATH", "");
    if (scenario !== "official-old") { vi.stubEnv("OAR_ANTIGRAVITY_BIN", scenario === "pinned-missing" ? path.join(home, "missing-agy") : old); }
    runExecutable.mockResolvedValue({ ok: true, exitCode: 0, stdout: scenario === "official-old" ? "1.4.9" : "Build label: 1.4.5", stderr: "" });
    const plan = await antigravityInstallPlan();
    expect(plan).toMatchObject({ kind: "unsupported", reason: "configuration" });
    expect(plan.kind === "unsupported" ? plan.detail : "").toContain(scenario === "pinned-missing" ? "missing-agy" : old);
    expect(await antigravityInstall()).toEqual(plan);
    expect(runExecutable.mock.calls.every(([, args]) => JSON.stringify(args) === '["--version"]')).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("antigravity accepts only the CLI release format and rejects a different executable", async () => {
  assert.equal(readAntigravityVersion("1.5.0\n"), "1.5.0");
  assert.equal(readAntigravityVersion("Build label: 1.4.5\n"), undefined);
  assert.equal(readAntigravityVersion("v24.0.0\n"), undefined);
  vi.stubEnv("OAR_ANTIGRAVITY_BIN", process.execPath);
  runExecutable.mockResolvedValue({ ok: true, exitCode: 0, stdout: "v24.0.0\n", stderr: "" });
  try {
    const result = await antigravityInstallation();
    expect(result.kind).toBe("unsupported");
    expect(result.kind === "unsupported" ? result.reason : "").toContain(process.execPath);
    expect(result.kind === "unsupported" ? result.reason : "").toContain("stable agy CLI 1.5.0");
  } finally { vi.unstubAllEnvs(); }
});

test("an old PATH copy does not block a new installation into the absent official location", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "oar-agy-path-only-"));
  const originalPath = process.env.PATH ?? "";
  try {
    isolatedHome(home);
    const old = scratchCli(home, "old", "1.4.9");
    vi.stubEnv("PATH", `${path.dirname(old)}${path.delimiter}${originalPath}`);
    runExecutable.mockResolvedValue({ ok: true, exitCode: 0, stdout: "1.4.9", stderr: "" });
    expect(await antigravityInstallation()).toMatchObject({ kind: "unsupported" });
    const plan = await antigravityInstallPlan();
    expect(plan.kind).toBe(process.platform === "win32" ? "unsupported" : "plan");
    if (plan.kind === "unsupported") { expect(plan.reason).toBe("platform"); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
