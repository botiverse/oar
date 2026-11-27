import { afterEach, expect, test, vi } from "vitest";
import type { ExecutableRunner } from "../../packages/oar/src/shared/executable/run.js";
import { qwenInstallation } from "../../packages/oar/src/runtimes/qwen/installation.js";
import { clearInstallationCache } from "../../packages/oar/src/shared/installation.js";

const runExecutable = vi.hoisted(() => vi.fn<ExecutableRunner>());
vi.mock("../../packages/oar/src/shared/executable/run.js", () => ({ runExecutable }));
afterEach(() => { runExecutable.mockReset(); vi.unstubAllEnvs(); clearInstallationCache(); });

const QWEN_HELP = "Usage: qwen [options] [command]\n\nQwen Code - Launch an interactive CLI\n";

test("installation verifies Qwen Code identity via --help and reads --version", async () => {
  vi.stubEnv("OAR_QWEN_BIN", process.execPath);
  runExecutable.mockImplementation(async (_command, args) => ({
    ok: true,
    exitCode: 0,
    stdout: args[0] === "--help" ? QWEN_HELP : "0.26.0\n",
    stderr: "",
  }));
  await expect(qwenInstallation()).resolves.toMatchObject({ kind: "available", version: "0.26.0" });
  // Both checks ask different questions of the same executable and run at
  // the same time, so only the two calls matter, not which started first.
  expect(runExecutable).toHaveBeenCalledTimes(2);
  expect(runExecutable).toHaveBeenCalledWith(process.execPath, ["--help"], { env: process.env });
  expect(runExecutable).toHaveBeenCalledWith(process.execPath, ["--version"], { env: process.env });
});

test("installation refuses a non-Qwen executable even when --help and --version exit zero", async () => {
  vi.stubEnv("OAR_QWEN_BIN", process.execPath);
  runExecutable.mockResolvedValue({ ok: true, exitCode: 0, stdout: "Usage: other-cli\n", stderr: "" });
  await expect(qwenInstallation()).resolves.toMatchObject({
    kind: "unsupported",
    code: "unrecognized_executable",
    via: "executable",
    command: process.execPath,
  });
});

test("a timed out installed executable throws a probe failure, never not_found", async () => {
  vi.stubEnv("OAR_QWEN_BIN", process.execPath);
  runExecutable.mockResolvedValue({ ok: false, exitCode: null, stdout: "", stderr: "startup incomplete",
    diagnostics: { exitCode: null, signal: "SIGTERM", stderr: "startup incomplete", timeoutMs: 15_000 } });
  const probing = qwenInstallation();
  await expect(probing).rejects.toThrow("timeout after 15000 ms");
  await expect(probing).rejects.toMatchObject({ cause: { timeoutMs: 15_000, stderr: "startup incomplete" } });
});
