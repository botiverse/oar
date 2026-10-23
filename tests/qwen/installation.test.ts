import { afterEach, expect, test, vi } from "vitest";
import type { ExecutableRunner } from "../../packages/oar/src/shared/executable/run.js";
import { qwenInstallation } from "../../packages/oar/src/runtimes/qwen/installation.js";

const runExecutable = vi.hoisted(() => vi.fn<ExecutableRunner>());
vi.mock("../../packages/oar/src/shared/executable/run.js", () => ({ runExecutable }));
afterEach(() => { runExecutable.mockReset(); vi.unstubAllEnvs(); });

test("installation uses one lightweight version query without starting help", async () => {
  vi.stubEnv("OAR_QWEN_BIN", process.execPath);
  runExecutable.mockResolvedValue({ ok: true, exitCode: null, stdout: "0.26.0\n", stderr: "" });
  await expect(qwenInstallation()).resolves.toMatchObject({ kind: "available", version: "0.26.0" });
  expect(runExecutable).toHaveBeenCalledExactlyOnceWith(process.execPath, ["--version"], {});
});

test("a timed out installed executable throws a probe failure, never not_found", async () => {
  vi.stubEnv("OAR_QWEN_BIN", process.execPath);
  runExecutable.mockResolvedValue({ ok: false, exitCode: null, stdout: "", stderr: "startup incomplete",
    diagnostics: { exitCode: null, signal: "SIGTERM", stderr: "startup incomplete", timeoutMs: 15_000 } });
  const probing = qwenInstallation();
  await expect(probing).rejects.toThrow("timeout after 15000 ms");
  await expect(probing).rejects.toMatchObject({ cause: { timeoutMs: 15_000, stderr: "startup incomplete" } });
});
