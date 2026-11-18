/* oxlint-disable max-statements -- Verify real child behavior, redaction and restoration in the same observer lifetime. */
import assert from "node:assert/strict";
import childProcess, { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "vitest";
import captureChildProcesses from "./fixtures/child-process-diagnostics.js";

test("sync diagnostics preserve native timeout results without retaining child inputs or outputs", () => {
  const original = childProcess.spawnSync;
  const capture = captureChildProcesses("sync-control");
  try {
    capture.stage("measured");
    const result = spawnSync(process.execPath, ["-e", "process.stdout.write('private-output'); setTimeout(() => {}, 1000)"], {
      timeout: 10, encoding: "utf8", env: { ...process.env, PRIVATE_DIAGNOSTIC_TEST: "private-env" },
    });
    assert.ok(result.error !== undefined && "code" in result.error);
    expect(result.error.code).toBe("ETIMEDOUT");
    expect(capture.snapshot().events).toContainEqual(expect.objectContaining({ kind: "result", status: result.status, signal: result.signal, code: "ETIMEDOUT", reason: "child deadline expired" }));
    expect(JSON.stringify(capture.snapshot())).not.toMatch(/private-output|private-env|PRIVATE_DIAGNOSTIC_TEST|setTimeout|"pid"/u);
  } finally { capture.stop(); }
  expect(childProcess.spawnSync).toBe(original);
  expect(spawnSync).toBe(original);
});

test("async diagnostics observe spawn errors without swallowing them or exposing their paths", async () => {
  const original = childProcess.spawn;
  const capture = captureChildProcesses("async-control");
  try {
    const child = spawn(join(process.cwd(), "private-executable-does-not-exist"));
    // errorMonitor must not count as a consumer of the native error event.
    expect(child.listenerCount("error")).toBe(0);
    const failed = Promise.withResolvers<Error>();
    const closed = Promise.withResolvers<void>();
    child.once("error", failed.resolve); child.once("close", () => { closed.resolve(); });
    const error = await failed.promise; await closed.promise;
    assert.ok("code" in error);
    expect(error.code).toBe("ENOENT");
    expect(capture.snapshot().events).toContainEqual(expect.objectContaining({ kind: "error", code: "ENOENT", reason: "executable or working directory missing" }));
    expect(JSON.stringify(capture.snapshot())).not.toContain("private-executable-does-not-exist");
    expect(capture.snapshot().events.some(event => event.kind === "close")).toBe(true);
  } finally { capture.stop(); }
  expect(childProcess.spawn).toBe(original);
  expect(spawn).toBe(original);
});

test("incomplete and truncated captures stay explicit without fabricated child completion", () => {
  const capture = captureChildProcesses("bounded-control");
  capture.stage("execute-entered");
  capture.stop();
  expect(capture.snapshot().events.map(event => event.kind)).toEqual(["stage"]);
  const bounded = captureChildProcesses("bounded-control");
  try {
    for (let index = 0; index < 140; index += 1) { bounded.stage("checkpoint"); }
    expect(bounded.snapshot()).toMatchObject({ dropped: 12 });
    expect(bounded.snapshot().events).toHaveLength(128);
  } finally { bounded.stop(); }
});
