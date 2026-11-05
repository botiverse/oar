import { afterEach, expect, test, vi } from "vitest";
import type { ExecutableRunner } from "../../packages/oar/src/shared/executable/run.js";
import { antigravityInstallation, antigravityInstalledExecutableCandidates } from "../../packages/oar/src/runtimes/antigravity/installation.js";
import { antigravityReleaseSource } from "../../packages/oar/src/runtimes/antigravity/update.js";

const runExecutable = vi.hoisted(() => vi.fn<ExecutableRunner>());
vi.mock("../../packages/oar/src/shared/executable/run.js", () => ({ runExecutable }));
afterEach(() => { runExecutable.mockReset(); vi.unstubAllEnvs(); });

test.each([
  ["1.5.0\n", "available"],
  ["1.4.9\n", "unsupported"],
  ["Build label: 1.4.5\n", "unsupported"],
])("native ACP requires the CLI version, not a successful unknown-command help: %j", async (stdout, kind) => {
  vi.stubEnv("OAR_ANTIGRAVITY_BIN", process.execPath);
  runExecutable.mockResolvedValue({ ok: true, exitCode: 0, stdout, stderr: "" });
  const result = await antigravityInstallation();
  expect(result.kind).toBe(kind);
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
