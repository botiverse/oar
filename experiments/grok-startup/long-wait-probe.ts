/* oxlint-disable import/max-dependencies -- Diagnostic probe composes the existing spawn policy, redactor and mock fixture. */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { sessionEnvironment } from "../../packages/oar/src/shared/environment.js";
import { resolveExecutable } from "../../packages/oar/src/shared/executable/resolve.js";
import { windowsSpawnTarget } from "../../packages/oar/src/shared/executable/windows-shim.js";
import { killProcessTree } from "../../packages/oar/src/shared/executable/process.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { sessionCredentialRedactor } from "../../packages/oar/src/shared/credential-redactor.js";
import { startGrokAimock } from "../../sea-trial/harness/aimock-acp.js";

assert.equal(process.platform, "win32", "This diagnostic measures Windows startup only");
const command = resolveExecutable("grok");
assert.ok(command !== null, "Install the pinned Grok package first");
const directory = process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run";
mkdirSync(directory, { recursive: true });
const output = path.join(directory, "grok-long-wait.jsonl");
const record = (value: Readonly<Record<string, unknown>>): void => { appendFileSync(output, `${JSON.stringify({ at: Date.now(), ...value })}\n`); };
const controlDirectory = mkdtempSync(path.join(tmpdir(), "oar-grok-cpu-"));
const controlFile = path.join(controlDirectory, "control.json");
const activeRoots = new Map<number, Readonly<Record<string, unknown>>>();
writeFileSync(controlFile, JSON.stringify({ roots: [], stop: false }));
const sampler = spawn("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", fileURLToPath(new URL("wait-cpu.ps1", import.meta.url)), "-ControlFile", controlFile], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
const ready = Promise.withResolvers<void>();
const samplerClosed = Promise.withResolvers<void>();
let samplerFailed = false;
let stoppingSampler = false;
const cpuSamples = new Map<number, number>();
createInterface({ input: sampler.stdout }).on("line", line => {
  const row = asRecord(parseJson(line));
  if (row === null) { samplerFailed = true; record({ phase: "sampler_invalid_output" }); return; }
  record(row);
  if (row.phase === "sampler_ready") { ready.resolve(); }
  if (row.phase === "cpu_sample" && typeof row.ordinal === "number" && typeof row.observedProcesses === "number" && row.observedProcesses > 0) { cpuSamples.set(row.ordinal, (cpuSamples.get(row.ordinal) ?? 0) + 1); }
  if (row.phase === "sampler_error" || row.phase === "sampler_limit") { samplerFailed = true; }
});
sampler.stderr.resume();
sampler.on("error", () => { samplerFailed = true; ready.reject(new Error("CPU sampler failed to start")); });
sampler.once("close", code => {
  if (!stoppingSampler || code !== 0) { samplerFailed = true; }
  ready.reject(new Error("CPU sampler closed before readiness")); samplerClosed.resolve();
});
const preparationTimer = setTimeout(() => { ready.reject(new Error("CPU sampler readiness exceeded 60 seconds")); }, 60_000);
const control = (value: Readonly<Record<string, unknown>>): void => {
  if (typeof value.ordinal === "number") {
    if (value.action === "add") { activeRoots.set(value.ordinal, value); }
    else { activeRoots.delete(value.ordinal); }
  }
  writeFileSync(controlFile, JSON.stringify({ roots: [...activeRoots.values()], stop: value.action === "stop" }));
};
let ordinal = 0;
let incomplete = false;
const children = new Set<ChildProcessWithoutNullStreams>();

async function launch(envValues: Readonly<Record<string, string>>, fixture: number, attempt: number): Promise<void> {
  const env = sessionEnvironment(envValues);
  const { redact } = sessionCredentialRedactor({ env: Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value ?? null])) });
  const target = windowsSpawnTarget(command ?? "grok", ["agent", "--always-approve", "--no-leader", "stdio"], { env });
  const index = ++ordinal;
  const started = performance.now();
  const earliest = Date.now();
  const context = { ordinal: index, firstProbeProcess: index === 1, fixture, attempt, initializeLimitMs: 90_000 };
  record({ phase: "spawn_requested", ...context });
  const child = spawn(target.command, [...target.args], { env, windowsHide: true, windowsVerbatimArguments: target.windowsVerbatimArguments ?? false, stdio: ["pipe", "pipe", "pipe"] });
  children.add(child);
  const closed = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<string>();
  const row = (phase: string, facts: Readonly<Record<string, unknown>> = {}): void => { record({ phase, ...context, elapsedMs: performance.now() - started, ...facts }); };
  child.once("close", (code, signal) => { row("close", { code, signal }); children.delete(child); closed.resolve(); });
  child.once("error", () => { row("spawn_error"); answer.resolve("spawn_error"); });
  child.once("exit", (code, signal) => { row("exit", { code, signal }); answer.resolve("exited_before_initialize"); });
  child.once("spawn", () => { row("spawned"); });
  child.stdin.on("error", () => { answer.resolve("stdin_error"); });
  if (child.pid !== undefined) { control({ action: "add", ordinal: index, pid: child.pid, earliest, latest: Date.now() }); }
  let first = true;
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
  child.stdout.on("data", () => { if (first) { first = false; row("first_stdout"); } });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    const frame = asRecord(parseJson(line));
    if (frame?.id !== 1) { return; }
    const ok = typeof asRecord(frame.result)?.protocolVersion === "number";
    row("initialize_response", { outcome: ok ? "result" : "native_error" });
    answer.resolve(ok ? "initialized" : "native_error");
  });
  // This raw experiment owns its own limit. It never changes an OAR profile.
  const timer = setTimeout(() => { answer.resolve("no_response_within_90s"); }, 90_000);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "oar", version: "0.0.0" }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: true } } })}\n`);
  row("initialize_sent");
  try {
    const outcome = await answer.promise;
    row("observation_end", { outcome, cpuSamples: cpuSamples.get(index) ?? 0, stderrTail: redact(stderr).split(/\r?\n/u).slice(-8).map(line => line.length > 512 ? "[long line omitted]" : line) });
    if (outcome !== "initialized") { incomplete = true; }
    if (performance.now() - started > 15_000 && (cpuSamples.get(index) ?? 0) === 0) { incomplete = true; row("missing_wait_cpu"); }
  } finally {
    clearTimeout(timer);
    control({ action: "remove", ordinal: index });
    killProcessTree(child);
    const cleanup = setTimeout(() => { incomplete = true; row("cleanup_limit"); closed.resolve(); }, 10_000);
    await closed.promise;
    clearTimeout(cleanup);
    lines.close(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    assert.ok(!children.has(child), "Probe process did not close after cleanup");
  }
}

async function pair(firstFixture: number): Promise<void> {
  const first = await startGrokAimock(mock => { mock.onMessage(/[\s\S]*/u, { content: "unused" }); });
  const second = await startGrokAimock(mock => { mock.onMessage(/[\s\S]*/u, { content: "unused" }); });
  try {
    const initial = await Promise.allSettled([launch(first.env, firstFixture, 1), launch(second.env, firstFixture + 1, 1)]);
    assert.ok(initial.every(result => result.status === "fulfilled"), "Initial launches did not cleanly finish");
    const repeated = await Promise.allSettled([launch(first.env, firstFixture, 2), launch(second.env, firstFixture + 1, 2)]);
    assert.ok(repeated.every(result => result.status === "fulfilled"), "Repeated launches did not cleanly finish");
  } finally { await Promise.all([first.stop(), second.stop()]); }
}

try {
  await ready.promise;
  clearTimeout(preparationTimer);
  record({ phase: "experiment", node: process.version, platform: process.platform, package: "@xai-official/grok@1.0.70", limitMs: 90_000, launches: 8, concurrency: 2, versionProbeBeforeLaunch: false });
  await pair(1);
  await pair(3);
} finally {
  clearTimeout(preparationTimer);
  for (const child of children) { killProcessTree(child); }
  stoppingSampler = true;
  control({ action: "stop" });
  const stopTimer = setTimeout(() => { samplerFailed = true; sampler.kill(); }, 10_000);
  await samplerClosed.promise;
  clearTimeout(stopTimer);
  rmSync(controlDirectory, { recursive: true, force: true });
  record({ phase: "experiment_end", launches: ordinal, incomplete, samplerFailed });
}
assert.equal(incomplete, false, "Diagnostic observation incomplete; inspect retained evidence");
assert.equal(samplerFailed, false, "CPU sampler incomplete; inspect retained evidence");
