/* oxlint-disable import/max-dependencies, max-statements, max-lines-per-function, eslint/no-await-in-loop -- A serial native evidence probe records every stage and cleanup before asserting. */
import assert from "node:assert/strict";
import { appendFile, copyFile, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { antigravityRuntime, type Session } from "../../packages/oar/src/index.js";
import type { ExecutableInstallation } from "../../packages/oar/src/contracts/installation.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { runExecutable } from "../../packages/oar/src/shared/executable/index.js";
import { descendantsOf, type ProcessEntry } from "../../packages/oar/src/shared/executable/process-tree.js";
import { startAntigravityAimock } from "../../sea-trial/harness/aimock-acp.js";
import { ECHO_SERVER } from "../../sea-trial/vendor/support/echo-mcp.js";
import { sanitizeAntigravityLog } from "../../sea-trial/vendor/support/antigravity-mcp-evidence.js";
import { prepareWindowsProcessTable } from "../../sea-trial/windows-process-table.js";
import { checkedProcessTable, recordProcessTableReads } from "../sharing/process-table.js";
import { running } from "../sharing/processes.js";

const out = path.resolve(process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run/antigravity-readiness", "native-probe");
await mkdir(out, { recursive: true });
recordProcessTableReads(path.join(out, "process-reads.jsonl"));
prepareWindowsProcessTable(path.join(out, "windows-process-preparation.jsonl"));
const found = await antigravityRuntime.installation();
assert.equal(found.kind, "available"); assert.equal(found.via, "executable");
const installation: ExecutableInstallation = found;
assert.equal(installation.version, process.env.OAR_READINESS_VERSION);
const observations: Record<string, unknown>[] = [];

function environment(values: Readonly<Record<string, string>>): Record<string, string> {
  const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && /^(?:path|systemroot|windir|comspec|pathext|temp|tmp)$/iu.test(entry[0])));
  return { ...inherited, ...values, HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost" };
}
function overlay(values: Readonly<Record<string, string>>): Record<string, string | null> {
  return { ...Object.fromEntries(Object.keys(process.env).map(key => [key, null])), ...values };
}
async function save(): Promise<void> {
  await writeFile(path.join(out, "report.json"), `${JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, version: installation.version, observations }, null, 2)}\n`);
}
async function measured(label: string, work: () => Promise<unknown>): Promise<unknown> {
  const start = performance.now();
  try {
    const result = await work(); observations.push({ label, elapsedMs: performance.now() - start, result }); return result;
  } catch (error) {
    const result = { kind: "probe_error", error: error instanceof Error ? error.name : "unknown", message: sanitizeAntigravityLog(String(error), [], ["aimock"]).slice(0, 2000) };
    observations.push({ label, elapsedMs: performance.now() - start, result }); return result;
  } finally { await save(); }
}

async function queries(): Promise<void> {
  const fixture = await startAntigravityAimock(() => {});
  const home = fixture.env.HOME; assert.ok(home !== undefined && home.length > 0);
  const env = overlay(environment(fixture.env));
  try {
    const configuredAuth = await measured("configured-provider-auth", async () => { const result = await antigravityRuntime.authStatus(installation, { env, timeoutMs: 15_000 }); return result; });
    assert.deepEqual(configuredAuth, { kind: "logged_in", source: "agy models" });
    await measured("configured-provider-usage", async () => { const result = await antigravityRuntime.accountUsage(installation, { env, timeoutMs: 15_000 }); return result; });
    // The synthetic provider has no Google quota. Preserve native's answer alongside the adapter outcome.
    await measured("configured-provider-native-usage", async () => {
      const result = await runExecutable(installation.command, ["-p", "/usage", "--output-format", "json"], { env: environment(fixture.env), timeoutMs: 15_000 });
      return { ok: result.ok, exitCode: result.exitCode,
        stdout: sanitizeAntigravityLog(result.stdout, [home], ["aimock"]).slice(0, 16_384),
        stderr: sanitizeAntigravityLog(result.stderr, [home], ["aimock"]).slice(0, 16_384),
        stdoutTruncated: result.stdout.length > 16_384, stderrTruncated: result.stderr.length > 16_384 };
    });
    assert.equal(fixture.raw.length, 0, "Read-only queries must not send a model prompt");
    await rm(path.join(home, ".gemini"), { recursive: true, force: true });
    const unsigned = { ...env, GEMINI_API_KEY: null };
    const auth = await measured("signed-out-auth", async () => { const result = await antigravityRuntime.authStatus(installation, { env: unsigned, timeoutMs: 15_000 }); return result; });
    const usage = await measured("signed-out-usage", async () => { const result = await antigravityRuntime.accountUsage(installation, { env: unsigned, timeoutMs: 15_000 }); return result; });
    assert.deepEqual(auth, { kind: "logged_out", source: "agy models" });
    assert.deepEqual(usage, { kind: "reauth_required", reason: "not_authenticated" });
    assert.equal(fixture.raw.length, 0);
  } finally { await fixture.stop(); }
}

async function lifecycle(label: string): Promise<void> {
  const fixture = await startAntigravityAimock(mock => { mock.onMessage(/READINESS/u, { content: "READINESS_OK" }); });
  const home = fixture.env.HOME; assert.ok(home !== undefined && home.length > 0);
  const cwd = path.join(home, "project space 中文");
  let { command } = installation;
  let selectedCwd = cwd;
  const env = environment(fixture.env);
  const row: Record<string, unknown> = { label, cwd: selectedCwd.replace(home, "<home>"), command: label === "cmd-shim" ? "<home>/binary space 中文/agy.CMD" : "verified-native", started: new Date().toISOString() };
  observations.push(row);
  let session: Session | undefined = undefined;
  let owned: ProcessEntry[] = [];
  const trace: unknown[] = [];
  try {
    await mkdir(cwd);
    if (label === "junction") {
      selectedCwd = path.join(home, "junction space 中文");
      await symlink(cwd, selectedCwd, process.platform === "win32" ? "junction" : "dir");
    }
    if (label === "cmd-shim") {
      const bin = path.join(home, "binary space 中文"); await mkdir(bin);
      const native = path.join(bin, "agy.exe"); await copyFile(command, native);
      command = path.join(bin, "agy.CMD");
      await writeFile(command, `@echo off\r\n"${native}" %*\r\n`);
    }
    row.cwd = selectedCwd.replace(home, "<home>");
    const selected: ExecutableInstallation = { ...installation, command };
    const version = await runExecutable(command, ["--version"], { env, timeoutMs: 30_000 });
    row.version = { ok: version.ok, stdout: version.stdout.trim(), exitCode: version.exitCode };
    assert.ok(version.ok); assert.equal(/\b\d+\.\d+\.\d+\b/u.exec(version.stdout)?.[0], installation.version);
    const before = checkedProcessTable(`${label}-before`, process.platform, true);
    session = await antigravityRuntime.session(selected, { cwd: selectedCwd, env: overlay(env), mcpServers: [{ name: "echo", command: process.execPath, args: [ECHO_SERVER, "--evidence", path.join(out, `${label}-mcp.jsonl`)] }] });
    session.rawEvents(record => { trace.push(record); });
    const opened = checkedProcessTable(`${label}-opened`, process.platform, true);
    owned = descendantsOf(opened, process.pid).filter(entry => before.get(entry.pid)?.start !== entry.start);
    row.openedProcesses = owned;
    assert.ok(owned.length > 0, "Native process identities must be observed");
    const turn = await promptAndWait(session, "READINESS", { timeoutMs: 30_000 });
    row.turn = turn.kind === "ended" ? { kind: turn.kind, outcome: turn.outcome, text: turn.text } : { kind: turn.kind };
    assert.equal(turn.kind, "ended"); assert.equal(turn.outcome.kind, "completed"); assert.ok(turn.text.includes("READINESS_OK"));
    const afterTurn = checkedProcessTable(`${label}-after-turn`, process.platform, true);
    for (const entry of descendantsOf(afterTurn, process.pid)) {
      if (before.get(entry.pid)?.start !== entry.start && !owned.some(previous => previous.pid === entry.pid && previous.start === entry.start)) { owned.push(entry); }
    }
    row.processesBeforeDispose = owned;
  } catch (error) {
    row.failure = sanitizeAntigravityLog(String(error), [home], ["aimock"]); throw error;
  } finally {
    const start = performance.now();
    try {
      let disposeFailed = false;
      try { await session?.dispose(); await session?.dispose(); } catch (error) { disposeFailed = true; row.disposeError = sanitizeAntigravityLog(String(error), [home], ["aimock"]); }
      row.disposeMs = performance.now() - start;
      const immediate = running(owned); row.survivorsAtDispose = immediate;
      if (immediate.length > 0) { await delay(5000); }
      const remaining = immediate.length > 0 ? running(owned) : [];
      row.survivorsAfterGrace = remaining;
      // Restore the isolated fixture after retaining the failed cleanup. Only the same PID/start identity can be killed.
      if (remaining.length > 0) {
        cleanSurvivors(label, owned, remaining);
        row.probeCleanupRequired = true;
      }
      assert.deepEqual(remaining, [], "Owned processes survived dispose and five-second observation grace");
      assert.equal(disposeFailed, false, "dispose failed");
    } finally {
      row.ended = new Date().toISOString();
      const clean = sanitizeAntigravityLog(trace.map(value => JSON.stringify(value)).join("\n"), [home], ["aimock"]);
      await appendFile(path.join(out, `${label}-records.jsonl`), `${clean}\n`);
      row.mcpEvidence = await readFile(path.join(out, `${label}-mcp.jsonl`), "utf8").then(text => text.trim().split("\n").map(line => parseJson(line))).catch(() => []);
      await save(); await fixture.stop();
    }
  }
}

function parseJson(line: string): unknown { return JSON.parse(line); }
function cleanSurvivors(label: string, owned: readonly ProcessEntry[], remaining: readonly number[]): void {
  const table = checkedProcessTable(`${label}-cleanup-identities`, process.platform, true);
  for (const entry of owned.toReversed()) {
    if (remaining.includes(entry.pid) && table.get(entry.pid)?.start === entry.start) {
      try { process.kill(entry.pid, "SIGKILL"); } catch { /* Already exited. */ }
    }
  }
}

const failures: string[] = [];
try { await queries(); } catch (error) { failures.push("queries"); observations.push({ label: "queries-failure", error: sanitizeAntigravityLog(String(error), [], ["aimock"]) }); }
for (const label of ["direct", "junction", ...(process.platform === "win32" ? ["cmd-shim"] : [])]) {
  try { await lifecycle(label); } catch { failures.push(label); }
}
await save();
assert.deepEqual(failures, [], `Probe failures: ${failures.join(", ")}`);
