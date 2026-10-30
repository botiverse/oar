import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { asRecord } from "../packages/oar/src/shared/json.js";

const pwsh = process.platform === "win32" ? "pwsh.exe" : process.env.OAR_TEST_PWSH_PATH;
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function targetPid(directory: string): Promise<number | null> {
  const text = await readFile(path.join(directory, "ready.json"), "utf8").catch(() => null);
  const pid = text === null ? undefined : asRecord(JSON.parse(text))?.pid;
  return typeof pid === "number" ? pid : null;
}
async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const end = performance.now() + timeoutMs;
  while (!predicate() && performance.now() < end) {
    // oxlint-disable-next-line no-await-in-loop -- Poll one process observation until its bounded deadline.
    await delay(25);
  }
}

// oxlint-disable-next-line max-statements -- Check each termination boundary against the same recorded process observation.
function expectTermination(records: ReturnType<typeof asRecord>[], mode: string, observed: { pid: number; exitedAt: number }): void {
  const { pid, exitedAt } = observed;
  expect(records.map((record) => record?.kind)).toEqual(mode === "normal" || mode === "returned-live"
    ? ["termination_start", "termination_returned", "termination_wait_returned", "stage_exit"]
    : ["termination_start", `termination_${mode}`, "stage_exit"]);
  expect(records[1]).toMatchObject({ pid });
  if (mode === "unreturned") { expect(records[1]).toMatchObject({ timeoutMs: 10_000 }); }
  if (mode === "error") { expect(records[1]).toMatchObject({ errorType: "InvalidOperationException" }); }
  if (mode === "normal") { expect(records[2]).toMatchObject({ rootExited: true, timeoutMs: 5000 }); }
  if (mode === "returned-live") {
    expect(records[2]?.rootExited).toBe(false);
    expect(Number(records[2]?.timeoutMs)).toBeLessThanOrEqual(2000);
    expect(exitedAt - Number(records[0]?.at)).toBeLessThan(12_000);
  }
  expect(Number(records[1]?.elapsedMs)).toBeLessThan(12_000);
  if (mode === "unreturned") { expect(Number(records[1]?.elapsedMs)).toBeGreaterThanOrEqual(10_000); }
  expect(records.at(-1)).toMatchObject({ kind: "stage_exit", exitCode: 124 });
  expect(exitedAt - Number(records.at(-1)?.at)).toBeLessThan(2000);
}

// oxlint-disable-next-line max-statements -- Prove root exit before scoped cleanup and then reclaim the intentionally surviving target.
test.skipIf(pwsh === undefined).each(["normal", "unreturned", "error", "returned-live"])("the monitor exits 124 when termination is %s", async (mode) => {
  assert.ok(pwsh !== undefined);
  const directory = await mkdtemp(path.join(tmpdir(), "oar-termination-"));
  const child = spawn(pwsh, ["-NoProfile", "-NonInteractive", "-File", path.resolve("tests/fixtures/windows-termination.ps1"),
    "-Mode", mode, "-OutputDirectory", directory, "-NodePath", process.execPath], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
  child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
  const exit = Promise.withResolvers<{ code: number | null; at: number }>();
  let closed = false;
  child.once("error", (error) => { exit.reject(error); });
  child.once("exit", (code) => { exit.resolve({ code, at: Date.now() }); });
  child.once("close", () => { closed = true; });
  const timeout = setTimeout(() => { exit.reject(new Error(`Monitor root did not exit: ${output}`)); }, 40_000);
  try {
    const result = await exit.promise;
    clearTimeout(timeout);
    expect(result.code, output).toBe(124);
    const pid = await targetPid(directory);
    assert.ok(pid !== null, output);
    if (mode !== "normal") { expect(await readFile(path.join(directory, "entered.txt"), "utf8")).toBe(String(pid)); }
    expect(alive(pid)).toBe(mode !== "normal");
    const contents = await readFile(path.join(directory, "records.jsonl"), "utf8");
    const records = contents.trim().split("\n").map((line) => asRecord(JSON.parse(line)));
    expectTermination(records, mode, { pid, exitedAt: result.at });
    // Root exit can precede delivery of the last flushed output chunk.
    await waitUntil(() => output.includes('"kind":"stage_exit"'), 1000);
    expect(output.trim().split(/\r?\n/u).map((line) => asRecord(JSON.parse(line)))).toEqual(records);
  } finally {
    clearTimeout(timeout);
    await writeFile(path.join(directory, "stop"), "");
    const pid = await targetPid(directory);
    if (pid !== null) { await waitUntil(() => !alive(pid), 5000); }
    if (child.exitCode === null) { child.kill(); }
    await waitUntil(() => closed, 5000);
    child.stdout.destroy(); child.stderr.destroy();
    expect(pid === null || !alive(pid), "The synthetic target must stop during cleanup").toBe(true);
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    expect(closed, "Pipes must close after the synthetic target stops").toBe(true);
  }
}, 55_000);
