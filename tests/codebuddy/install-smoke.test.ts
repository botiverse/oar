import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { tmpdir } from "node:os";
import path from "node:path";
import { runExecutable } from "../../packages/oar/src/shared/executable/index.js";
import { mkdtemp, rm } from "node:fs/promises";
// oxlint-disable-next-line import/no-namespace -- Preserve all real filesystem exports except the controlled temporary directory boundary.
import type * as FilesModule from "node:fs/promises";
// oxlint-disable-next-line import/no-namespace -- Preserve executable utilities while replacing only the smoke's child runner.
import type * as ExecutableModule from "../../packages/oar/src/shared/executable/index.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof FilesModule>();
  return { ...actual, mkdtemp: vi.fn(), rm: vi.fn() };
});
vi.mock("../../packages/oar/src/shared/executable/index.js", async importOriginal => {
  const actual = await importOriginal<typeof ExecutableModule>();
  return { ...actual, runExecutable: vi.fn() };
});

const directory = path.join(tmpdir(), "oar-codebuddy-smoke-fixture");
const cleanupError = Object.assign(new Error("fixture directory is still busy"), { code: "ENOTEMPTY" });
const output = vi.fn<typeof process.stdout.write>().mockReturnValue(true);
const diagnostic = vi.fn<typeof process.stderr.write>().mockReturnValue(true);
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("OAR_TEST", "codebuddy-install");
  vi.mocked(mkdtemp).mockResolvedValue(directory);
  vi.mocked(rm).mockRejectedValue(cleanupError);
  vi.spyOn(process.stdout, "write").mockImplementation(output);
  vi.spyOn(process.stderr, "write").mockImplementation(diagnostic);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function expectCleanupDiagnostic() {
  expect(rm).toHaveBeenCalledExactlyOnceWith(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  expect(diagnostic).toHaveBeenCalledExactlyOnceWith(`${JSON.stringify({
    kind: "codebuddy_install_cleanup_failed", directory, code: "ENOTEMPTY", message: cleanupError.message,
  })}\n`);
}

test("a successful smoke keeps its result when temporary directory cleanup fails", async () => {
  vi.mocked(runExecutable).mockResolvedValue({ ok: true, stdout: "installed version\n", stderr: "", exitCode: 0 });
  await import("./install-smoke.js");
  expect(output).toHaveBeenCalledExactlyOnceWith("installed version\n");
  expectCleanupDiagnostic();
});

test("installation failure remains the primary error when directory cleanup also fails", async () => {
  vi.mocked(runExecutable).mockResolvedValue({ ok: false, stdout: "installer output", stderr: "native installation failed", exitCode: 7 });
  await expect(import("./install-smoke.js")).rejects.toMatchObject({
    name: "AssertionError", message: "installer output\nnative installation failed",
  });
  expectCleanupDiagnostic();
});

test("a thrown installer error keeps its identity when directory cleanup also fails", async () => {
  const original = new Error("installer transport failed");
  vi.mocked(runExecutable).mockRejectedValue(original);
  await expect(import("./install-smoke.js")).rejects.toBe(original);
  expectCleanupDiagnostic();
});
