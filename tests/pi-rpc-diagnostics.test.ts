import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { runExecutable, type ExecutableResult } from "../packages/oar/src/shared/executable/run.js";
import { asRecord } from "../packages/oar/src/shared/json.js";

const vitestEntry = pathToFileURL(path.resolve("node_modules/vitest/dist/index.js")).href;
const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

async function recordProbe(directory: string, run: () => Promise<ExecutableResult>): Promise<ExecutableResult> {
  const checkpoint = async (kind: string): Promise<void> => {
    await appendFile(path.join(directory, "launcher.jsonl"), `${JSON.stringify({ kind, at: new Date().toISOString() })}\n`)
      .catch((error: unknown) => { console.error("Probe checkpoint unavailable", asRecord(error)?.code); });
  };
  await checkpoint("launch_requested");
  const result = await run();
  // Keep the timeout's exit/close observation, even if the assertion below
  // fails or temporary fixture cleanup throws. No environment is captured.
  await writeFile(path.join(directory, "result.json"), `${JSON.stringify(result, null, 2)}\n`)
    .catch((error: unknown) => { console.error("Probe result unavailable", asRecord(error)?.code); });
  await checkpoint("launch_returned");
  return result;
}

// oxlint-disable-next-line max-statements -- Exercise a real outer timeout and inspect its evidence after fixture removal.
test("an outer probe timeout retains diagnostics after fixture cleanup", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-probe-evidence-"));
  const fixtureDirectory = await mkdtemp(path.join(tmpdir(), "oar-probe-fixture-"));
  try {
    const fixture = path.join(fixtureDirectory, "wait.cjs");
    await writeFile(fixture, "setInterval(() => {}, 1000);");
    const result = await recordProbe(directory, async () => runExecutable(process.execPath, [fixture], { timeoutMs: 200 }));
    await rm(fixtureDirectory, { recursive: true, force: true });
    expect(result.ok).toBe(false);
    expect(result.diagnostics?.timeoutMs).toBe(200);
    expect(result.diagnostics?.timeoutObservation).toMatchObject({ closeObserved: false });
    const saved = await readFile(path.join(directory, "result.json"), "utf8");
    expect(JSON.parse(saved)).toEqual(result);
    const contents = await readFile(path.join(directory, "launcher.jsonl"), "utf8");
    const records = contents.trim().split("\n").map((line) => asRecord(JSON.parse(line)));
    expect(records.map((record) => record?.kind)).toEqual(["launch_requested", "launch_returned"]);
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// oxlint-disable-next-line max-statements -- Exercise the actual child runner and its durable evidence together.
test("the reporter persists the name and failure of a timed-out test", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-pi-progress-"));
  const fixture = path.join(directory, "probe.test.ts");
  const config = path.join(directory, "vitest.config.mjs");
  try {
    await writeFile(fixture, `import { test } from ${JSON.stringify(vitestEntry)};
test("named pending fixture", async () => { await new Promise(() => {}); });`);
    await writeFile(config, `export default { root: ${JSON.stringify(directory)}, test: { include: ["probe.test.ts"], testTimeout: 100, reporters: [${JSON.stringify(path.resolve("sea-trial/pi-rpc-progress.ts"))}] } };`);
    const result = await runExecutable(process.execPath, [path.resolve("node_modules/vitest/vitest.mjs"), "run", "--config", config], {
      timeoutMs: 20_000, env: { ...process.env, OAR_PI_RPC_DIAGNOSTICS: directory },
    });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(1);
    const contents = await readFile(path.join(directory, "tests.jsonl"), "utf8");
    const records = contents.trim().split("\n").map((line) => asRecord(JSON.parse(line)));
    expect(records, `${result.stdout}\n${result.stderr}`).toContainEqual(expect.objectContaining({ kind: "case_start", name: "named pending fixture" }));
    expect(records).toContainEqual(expect.objectContaining({ kind: "case_end", name: "named pending fixture", state: "failed" }));
    const active = await readFile(path.join(directory, "active-tests.json"), "utf8");
    expect(JSON.parse(active)).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);

// oxlint-disable-next-line max-statements -- Hold a real Windows file handle across the child test runner.
test.skipIf(process.platform !== "win32").each([true, false])("a locked snapshot preserves the child test result (passes=%s)", async (passes) => {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-pi-progress-file-lock-"));
  const snapshot = path.join(directory, "active-tests.json");
  const config = path.join(directory, "vitest.config.mjs");
  try {
    await writeFile(snapshot, "[]");
    await writeFile(path.join(directory, "probe.test.ts"), `import { expect, test } from ${JSON.stringify(vitestEntry)};
test("result under file lock", () => { expect(${String(passes)}).toBe(true); });`);
    await writeFile(config, `export default { root: ${JSON.stringify(directory)}, test: { include: ["probe.test.ts"], reporters: ["default", ${JSON.stringify(path.resolve("sea-trial/pi-rpc-progress.ts"))}] } };`);
    const command = `$ErrorActionPreference = 'Stop'; $file = [System.IO.File]::Open(${quote(snapshot)}, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite); try { & ${quote(process.execPath)} ${quote(path.resolve("node_modules/vitest/vitest.mjs"))} run --config ${quote(config)}; $code = $LASTEXITCODE } finally { $file.Dispose() }; exit $code`;
    const result = await runExecutable("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      timeoutMs: 25_000, env: { ...process.env, OAR_PI_RPC_DIAGNOSTICS: directory },
    });
    const output = `${result.stdout}\n${result.stderr}\n${JSON.stringify(result.diagnostics)}`;
    expect(result.ok, output).toBe(passes);
    expect(result.exitCode, output).toBe(passes ? null : 1);
    if (passes) { expect(result.diagnostics, output).toBeUndefined(); }
    expect(output).not.toContain("Unhandled Rejection");
    const contents = await readFile(path.join(directory, "tests.jsonl"), "utf8");
    const records = contents.trim().split("\n").map((line) => asRecord(JSON.parse(line)));
    expect(records, output).toContainEqual(expect.objectContaining({ kind: "diagnostic_write_failed", operation: "rename", code: "EPERM", attempts: 3 }));
    expect(records).toContainEqual(expect.objectContaining({ kind: "case_end", name: "result under file lock", state: passes ? "passed" : "failed" }));
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}, 35_000);

// oxlint-disable-next-line max-statements -- Verify a real blocked worker is stopped without losing its name.
test.skipIf(process.platform !== "win32")("the external Windows deadline kills a blocked worker and retains its test name", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-pi-watchdog-"));
  const evidenceRoot = path.resolve(process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run", "pi-rpc-diagnostics");
  await mkdir(evidenceRoot, { recursive: true });
  // Evidence lives outside the disposable fixture from the start, including
  // when the enclosing test times out before runExecutable can return.
  const evidence = await mkdtemp(path.join(evidenceRoot, "watchdog-"));
  const fixture = path.join(directory, "probe.test.ts");
  const config = path.join(directory, "vitest.config.mjs");
  try {
    await writeFile(fixture, `import { appendFileSync, readFileSync } from "node:fs";
import { expect, test } from ${JSON.stringify(vitestEntry)};
const mark = (kind) => { try { appendFileSync(${JSON.stringify(path.join(evidence, "worker.jsonl"))}, JSON.stringify({ kind, at: new Date().toISOString() }) + "\\n"); } catch {} };
mark("module_loaded");
test("blocked native worker", async () => { mark("case_entered");
  // Vitest batches worker updates. Wait for the reporter before blocking delivery.
  await expect.poll(() => {
    try { return JSON.parse(readFileSync(${JSON.stringify(path.join(evidence, "active-tests.json"))}, "utf8")).some(entry => entry.name === "blocked native worker"); }
    catch { return false; }
  }, { timeout: 900, interval: 10 }).toBe(true);
  mark("worker_blocking"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
});`);
    await writeFile(config, `export default { root: ${JSON.stringify(directory)}, test: { include: ["probe.test.ts"], testTimeout: 1000, reporters: [${JSON.stringify(path.resolve("sea-trial/pi-rpc-progress.ts"))}] } };`);
    const command = `& ${quote(process.execPath)} ${quote(path.resolve("node_modules/vitest/vitest.mjs"))} run --config ${quote(config)}`;
    const result = await recordProbe(evidence, async () => runExecutable("pwsh.exe", ["-NoProfile", "-File", path.resolve("sea-trial/windows-resources.ps1"),
      "-Stage", "blocked", "-Command", command, "-OutputDirectory", evidence, "-ActiveTestsPath", path.join(evidence, "active-tests.json"),
      "-CaseTimeoutSeconds", "2", "-CommandTimeoutSeconds", "20", "-IntervalMs", "1000"], {
      timeoutMs: 35_000, env: { ...process.env, OAR_PI_RPC_DIAGNOSTICS: evidence },
    }));
    expect(result.exitCode, JSON.stringify(result)).toBe(124);
    expect(result.stdout).toContain("blocked native worker exceeded the external 2 second case deadline");
    const contents = await readFile(path.join(evidence, "blocked.jsonl"), "utf8");
    const records = contents.trim().split("\n").map((line) => asRecord(JSON.parse(line)));
    const pid = records.find((record) => record?.kind === "command_start")?.pid;
    expect(pid).toEqual(expect.any(Number));
    const checkpoints = records.filter((record) => record?.kind === "case_timeout" || String(record?.kind).startsWith("termination_"));
    expect(checkpoints).toEqual([
      expect.objectContaining({ kind: "case_timeout", name: "blocked native worker", timeoutSeconds: 2 }),
      expect.objectContaining({ kind: "termination_start", pid }),
      expect.objectContaining({ kind: "termination_returned", pid }),
      expect.objectContaining({ kind: "termination_wait_returned", pid, rootExited: true, timeoutMs: 5000 }),
    ]);
    expect(checkpoints[2]?.elapsedMs).toEqual(expect.any(Number));
    const logged = result.stdout.split(/\r?\n/u).filter((line) => line.startsWith("resources {")).map((line) => asRecord(JSON.parse(line.slice("resources ".length))));
    expect(logged).toEqual([...checkpoints, expect.objectContaining({ kind: "stage_exit", pid, exitCode: 124 })]);
    const workerContents = await readFile(path.join(evidence, "worker.jsonl"), "utf8");
    const worker = workerContents.trim().split("\n").map((line) => asRecord(JSON.parse(line)));
    expect(worker.map((record) => record?.kind)).toEqual(["module_loaded", "case_entered", "worker_blocking"]);
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}, 45_000);
