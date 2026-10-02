import assert from "node:assert/strict";
import { afterEach, expect, test, vi } from "vitest";
import { runExecutable, spawnLineProcess } from "../packages/oar/src/shared/executable/index.js";
import { executableInstallation } from "../packages/oar/src/shared/installation.js";

const tail = "native startup failed\n";

afterEach(() => { vi.unstubAllEnvs(); });

test("one-shot failures keep the exit code and a bounded stderr tail", async () => {
  const result = await runExecutable(process.execPath, ["-e", `process.stderr.write("x".repeat(65536) + ${JSON.stringify(tail)}); process.exitCode = 7;`]);
  expect(result.ok).toBe(false);
  expect(result.diagnostics).toEqual({ exitCode: 7, signal: null, stderr: `${"x".repeat(8192 - tail.length)}${tail}` });
});

test("one-shot timeout retains the unchanged caller deadline", async () => {
  const result = await runExecutable(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 100 });
  expect(result.ok).toBe(false);
  expect(result.diagnostics?.timeoutMs).toBe(100);
});

test.skipIf(process.platform === "win32")("an external signal is not reported as a timeout", async () => {
  const result = await runExecutable(process.execPath, ["-e", 'process.stderr.write("signal-tail", () => process.kill(process.pid, "SIGTERM"));']);
  expect(result.diagnostics).toMatchInlineSnapshot(`
    {
      "exitCode": null,
      "signal": "SIGTERM",
      "stderr": "signal-tail",
    }
  `);
});

test("a missing one-shot executable retains the native spawn error", async () => {
  const result = await runExecutable("/nonexistent/oar-diagnostic-fixture", []);
  expect(result.diagnostics?.error).toMatchInlineSnapshot(`
    {
      "code": "ENOENT",
      "message": "spawn /nonexistent/oar-diagnostic-fixture ENOENT",
    }
  `);
});

test("maxBuffer failure is not classified as a timeout", async () => {
  const result = await runExecutable(process.execPath, ["-e", 'process.stderr.write("x".repeat(3 * 1024 * 1024));']);
  expect(result.ok).toBe(false);
  expect(result.diagnostics?.timeoutMs).toBeUndefined();
  expect(result.diagnostics?.error?.code).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
  expect(Buffer.byteLength(result.diagnostics?.stderr ?? "")).toBe(8192);
});

test("an installation timeout exposes its cause without extending the deadline", async () => {
  const probe = executableInstallation("OAR_DIAGNOSTIC_FIXTURE_BIN", process.execPath, [],
    ["-e", "setInterval(() => {}, 1000)"], { readinessTimeoutMs: 100 });
  const failure: unknown = await probe().catch((error: unknown) => error);
  assert.ok(failure instanceof Error);
  expect(failure.cause).toMatchObject({ timeoutMs: 100 });
});

test("stderr is drained beyond pipe capacity and only its final 8 KiB are retained", async () => {
  const child = spawnLineProcess(process.execPath, ["-e", `process.stderr.write("x".repeat(1024 * 1024) + ${JSON.stringify(tail)}, () => { process.stdout.write("drained\\n"); process.exitCode = 7; });`]);
  const lines: string[] = [];
  child.onLine((line) => { lines.push(line); });
  await child.spawned;
  await child.exited;
  expect(lines).toEqual(["drained"]);
  expect(child.diagnostics()).toEqual({ exitCode: 7, signal: null, stderr: `${"x".repeat(8192 - tail.length)}${tail}` });
});

test.skipIf(process.platform === "win32")("long-running process diagnostics preserve its exit signal", async () => {
  const child = spawnLineProcess(process.execPath, ["-e", 'process.stderr.write("signal-tail", () => process.kill(process.pid, "SIGTERM"));']);
  await child.spawned;
  await child.exited;
  expect(child.diagnostics()).toMatchInlineSnapshot(`
    {
      "exitCode": null,
      "signal": "SIGTERM",
      "stderr": "signal-tail",
    }
  `);
});

test("stderr passthrough still captures the tail", async () => {
  vi.stubEnv("OAR_CHILD_STDERR", "inherit");
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const child = spawnLineProcess(process.execPath, ["-e", 'process.stderr.write("passthrough-tail");']);
  try {
    await child.spawned;
    await child.exited;
    expect(child.diagnostics().stderr).toBe("passthrough-tail");
    expect(write.mock.calls.map(([chunk]) => String(chunk)).join("")).toBe("passthrough-tail");
  } finally {
    write.mockRestore();
  }
});

test("synchronous execution errors also retain the native error code", async () => {
  const result = await runExecutable("invalid\0binary", []);
  expect(result.ok).toBe(false);
  expect(result.diagnostics?.error?.code).toBe("ERR_INVALID_ARG_VALUE");
});

test("stderr truncation preserves whole UTF-8 characters at the byte boundary", async () => {
  const child = spawnLineProcess(process.execPath, ["-e", 'process.stderr.write("🌊".repeat(3000) + "END");']);
  await child.spawned;
  await child.exited;
  expect(child.diagnostics().stderr).toBe(`${"🌊".repeat(2047)}END`);
  expect(Buffer.byteLength(child.diagnostics().stderr)).toBeLessThanOrEqual(8192);
});
