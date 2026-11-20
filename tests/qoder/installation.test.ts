import { afterEach, expect, test, vi } from "vitest";
import type { ExecutableRunner } from "../../packages/oar/src/shared/executable/run.js";
import { qoderInstallation } from "../../packages/oar/src/runtimes/qoder/installation.js";
import { qoderRuntime } from "../../packages/oar/src/runtimes/qoder/index.js";
import { clearInstallationCache } from "../../packages/oar/src/shared/installation.js";

const runExecutable = vi.hoisted(() => vi.fn<ExecutableRunner>());
vi.mock("../../packages/oar/src/shared/executable/run.js", () => ({ runExecutable }));
afterEach(() => { runExecutable.mockReset(); vi.unstubAllEnvs(); clearInstallationCache(); });

const QODER_HELP = "Usage: qodercli [options] [command] [query...]\n\nQoder CLI - Defaults to interactive mode.\n";

function mockQoder(versionStdout: string): void {
  runExecutable.mockImplementation(async (_command, args) => ({
    ok: true,
    exitCode: 0,
    stdout: args[0] === "--help" ? QODER_HELP : versionStdout,
    stderr: "",
  }));
}

test("installation verifies Qoder CLI identity via --help and reads --version", async () => {
  vi.stubEnv("OAR_QODER_BIN", process.execPath);
  mockQoder("1.1.78\n");
  await expect(qoderInstallation()).resolves.toMatchObject({ kind: "available", version: "1.1.78" });
  expect(runExecutable).toHaveBeenNthCalledWith(1, process.execPath, ["--help"], { env: process.env });
  expect(runExecutable).toHaveBeenNthCalledWith(2, process.execPath, ["--version"], { env: process.env });
});

test("a timed out installed executable throws a probe failure, never not_found", async () => {
  vi.stubEnv("OAR_QODER_BIN", process.execPath);
  runExecutable.mockResolvedValue({ ok: false, exitCode: null, stdout: "", stderr: "startup incomplete",
    diagnostics: { exitCode: null, signal: "SIGTERM", stderr: "startup incomplete", timeoutMs: 15_000 } });
  const probing = qoderInstallation();
  await expect(probing).rejects.toThrow("timeout after 15000 ms");
  await expect(probing).rejects.toMatchObject({ cause: { timeoutMs: 15_000, stderr: "startup incomplete" } });
});

test("Qoder 1.0.22 is found but unsupported before a host opens a session", async () => {
  vi.stubEnv("OAR_QODER_BIN", process.execPath);
  mockQoder("1.0.22\n");
  expect(qoderRuntime.minVersion).toBe("1.1.78");
  await expect(qoderRuntime.installation()).resolves.toMatchObject({
    kind: "unsupported", code: "version_unsupported", via: "executable", command: process.execPath,
    installedVersion: "1.0.22", requiredVersion: "1.1.78",
  });
});

test.each(["1.1.78", "1.1.81"])("Qoder %s remains available", async version => {
  vi.stubEnv("OAR_QODER_BIN", process.execPath);
  mockQoder(`${version}\n`);
  await expect(qoderRuntime.installation()).resolves.toMatchObject({ kind: "available", via: "executable", version });
});

test.each(["1.1.77", "1.1.78-rc.1", ""])("an unverified Qoder version cannot bypass the floor: %s", async version => {
  vi.stubEnv("OAR_QODER_BIN", process.execPath);
  mockQoder(version);
  await expect(qoderRuntime.installation()).resolves.toMatchObject({
    kind: "unsupported", code: "version_unsupported", command: process.execPath, requiredVersion: "1.1.78",
  });
});

test("a non-Qoder executable is refused as unrecognized_executable", async () => {
  vi.stubEnv("OAR_QODER_BIN", process.execPath);
  runExecutable.mockResolvedValue({ ok: true, exitCode: 0, stdout: "Usage: other-cli\n", stderr: "" });
  await expect(qoderRuntime.installation()).resolves.toMatchObject({
    kind: "unsupported", code: "unrecognized_executable", via: "executable", command: process.execPath,
  });
});
