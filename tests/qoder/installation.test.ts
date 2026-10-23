import { afterEach, expect, test, vi } from "vitest";
import type { ExecutableRunner } from "../../packages/oar/src/shared/executable/run.js";
import { qoderInstallation } from "../../packages/oar/src/runtimes/qoder/installation.js";

const runExecutable = vi.hoisted(() => vi.fn<ExecutableRunner>());
vi.mock("../../packages/oar/src/shared/executable/run.js", () => ({ runExecutable }));
afterEach(() => { runExecutable.mockReset(); vi.unstubAllEnvs(); });

test("installation uses one lightweight version query without starting help", async () => {
  vi.stubEnv("OAR_QODER_BIN", process.execPath);
  runExecutable.mockResolvedValue({ ok: true, exitCode: null, stdout: "1.1.78\n", stderr: "" });
  await expect(qoderInstallation()).resolves.toMatchObject({ kind: "available", version: "1.1.78" });
  expect(runExecutable).toHaveBeenCalledExactlyOnceWith(process.execPath, ["--version"], {});
});

test("a timed out installed executable throws a probe failure, never not_found", async () => {
  vi.stubEnv("OAR_QODER_BIN", process.execPath);
  runExecutable.mockResolvedValue({ ok: false, exitCode: null, stdout: "", stderr: "startup incomplete",
    diagnostics: { exitCode: null, signal: "SIGTERM", stderr: "startup incomplete", timeoutMs: 15_000 } });
  const probing = qoderInstallation();
  await expect(probing).rejects.toThrow("timeout after 15000 ms");
  await expect(probing).rejects.toMatchObject({ cause: { timeoutMs: 15_000, stderr: "startup incomplete" } });
});
