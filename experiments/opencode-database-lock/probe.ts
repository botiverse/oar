import { acquireOpenCodeStartup } from "../../packages/oar/src/runtimes/opencode/startup-gate.js";
import type { Observation } from "./observation.js";
/** Native ACP startup controls with optional OAR gate/adapter, no login, prompt or retries. */
/* oxlint-disable eslint/no-await-in-loop, eslint/no-continue, eslint/max-depth -- Sequential starts and rounds are experimental controls. */
/* oxlint-disable promise/avoid-new -- Bridge native process and HTTP lifecycle callbacks. */
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { createInterface } from "node:readline";

const [binary, destination = "oar-trial-run/opencode-database-lock", roundsText = "10", shutdown = "eof", selection = "shared,separate,serial"] = process.argv.slice(2);
assert.ok(binary !== undefined && path.isAbsolute(binary), "Provide an absolute OpenCode executable");
assert.notEqual(process.platform, "win32", "This probe owns POSIX process groups");
const command = binary;
// v1 accepts DEBUG; v2 requires debug. This changes logging only.
const nativeArgs = ["acp", "--print-logs", "--log-level", process.env.OAR_LOCK_LOG_LEVEL ?? "DEBUG"];
const rounds = Number(roundsText);
assert.ok(Number.isInteger(rounds) && rounds > 0 && rounds <= 100, "Rounds must be 1..100");
const output = path.resolve(destination);
await mkdir(path.dirname(output), { recursive: true });
await mkdir(output, { mode: 0o700 }); // Refuse to reuse a previous experiment directory.
const providerRequests: string[] = [];
const server = createServer((request, response) => {
  providerRequests.push(request.url ?? "");
  response.writeHead(500).end("No model requests are expected");
});
await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve); });
const address = server.address();
assert.ok(address !== null && typeof address !== "string");
const { port } = address;
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "LANG", "LC_ALL", "TMPDIR"].includes(key)));

async function environment(name: string): Promise<NodeJS.ProcessEnv> {
  const root = path.join(output, name);
  const dirs = Object.fromEntries(["home", "config", "data", "state", "cache", "project"].map(key => [key, path.join(root, key)]));
  await Promise.all(Object.values(dirs).map(async dir => { await mkdir(dir, { recursive: true, mode: 0o700 }); }));
  const { config, home } = dirs;
  assert.ok(config !== undefined && home !== undefined);
  await mkdir(path.join(config, "opencode"), { recursive: true });
  await writeFile(path.join(config, "opencode", "opencode.json"), JSON.stringify({
    model: "aimock/model", small_model: "aimock/model", autoupdate: false, share: "disabled",
    provider: { aimock: { npm: "@ai-sdk/anthropic", options: { baseURL: `http://127.0.0.1:${String(port)}/v1`, apiKey: "synthetic" }, models: { model: { name: "local", limit: { context: 200_000, output: 8192 } } } } },
  }));
  return {
    ...inherited, HOME: dirs.home, OPENCODE_TEST_HOME: dirs.home, XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data,
    XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.state,
    OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
  };
}

const startupTails = new Map<string, Promise<void>>();
async function acquireStartup(directory: string): Promise<() => void> {
  const prior = startupTails.get(directory) ?? Promise.resolve();
  const next = Promise.withResolvers<void>();
  startupTails.set(directory, next.promise);
  await prior;
  return next.resolve;
}

function noGate(): void {}

async function sample(name: string, env: NodeJS.ProcessEnv, gate: "none" | "probe" | "oar" = "none"): Promise<Observation> {
  const began = performance.now();
  const row: Observation = { name, startedAtMs: began, guarded: gate !== "none", gate, initialized: false, opened: false, startedAt: new Date().toISOString(), elapsedMs: 0, exitCode: null, signal: null };
  const data = env.XDG_DATA_HOME; assert.ok(data !== undefined);
  const cwd = env.HOME; assert.ok(cwd !== undefined);
  let release = noGate;
  if (gate === "oar") { release = await acquireOpenCodeStartup({ cwd, env: { HOME: cwd, XDG_DATA_HOME: data } }); }
  else if (gate === "probe") { release = await acquireStartup(data); }
  row.queueMs = performance.now() - began;
  const trace = process.env.OAR_LOCK_STRACE === "1";
  const args = trace ? ["-f", "-ttt", "-yy", "-e", "trace=fcntl,openat,close,unlink", "-o", path.join(output, `${name}.strace`), command, ...nativeArgs] : nativeArgs;
  const child = spawn(trace ? "/usr/bin/strace" : command, args, { cwd: env.HOME, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  if (child.pid !== undefined) { row.pid = child.pid; }
  let stderr = "";
  let stdout = "";
  let exited = false;
  const closed = Promise.withResolvers<void>();
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  child.stdin.on("error", () => {});
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    try {
      const message = asRecord(parseJson(line));
      if (message === null) { return; }
      if (typeof message.id !== "number") { return; }
      const waiter = pending.get(message.id);
      if (waiter === undefined) { return; }
      pending.delete(message.id);
      if (message.error === undefined) {
        const result = asRecord(message.result);
        if (result === null) { waiter.reject(new Error("ACP result is not an object")); } else { waiter.resolve(result); }
      } else { waiter.reject(new Error(JSON.stringify(message.error))); }
    } catch { /* Preserve non-JSON stdout as evidence. */ }
  });
  child.on("error", error => { row.error = error.message; });
  child.on("close", (code, signal) => {
    exited = true; row.exitCode = code; row.signal = signal;
    for (const waiter of pending.values()) { waiter.reject(new Error(`Native exit ${String(code)} ${String(signal)}`)); }
    pending.clear(); closed.resolve();
  });
  let nextId = 0;
  const rpc = async (method: string, params: object): Promise<Record<string, unknown>> => {
    const id = ++nextId;
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      if (exited) { reject(new Error("Native process already exited")); return; }
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Deadline waiting for ${method}`)); }, 20_000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
    return result;
  };
  try {
    const initialized = await rpc("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "oar-lock-probe", version: "1" } });
    row.initialized = true;
    row.initializeMs = performance.now() - began;
    release(); release = noGate;
    const agent = asRecord(initialized.agentInfo);
    if (typeof agent?.version === "string") { row.version = agent.version; }
    await rpc("session/new", { cwd: env.HOME, mcpServers: [] });
    row.opened = true;
  } catch (error) { row.error = error instanceof Error ? error.message : String(error); }
  finally {
    row.elapsedMs = performance.now() - began;
    if (shutdown === "term") { child.kill("SIGTERM"); }
    child.stdin.end();
    const timer = setTimeout(() => { if (child.pid !== undefined) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } } }, 2000);
    await closed.promise;
    row.closedMs = performance.now() - began;
    release();
    clearTimeout(timer); lines.close();
    await writeFile(path.join(output, `${name}.stderr.log`), stderr, { mode: 0o600 });
    await writeFile(path.join(output, `${name}.stdout.jsonl`), stdout, { mode: 0o600 });
  }
  process.stdout.write(`${name}: ${row.opened ? "opened" : "FAILED"} ${String(Math.round(row.elapsedMs))}ms\n`);
  return row;
}

const results: Observation[] = [];
try {
  const shared = await environment("shared");
  const data = shared.XDG_DATA_HOME; assert.ok(data !== undefined);
  const separate = await Promise.all([environment("separate-a"), environment("separate-b")]);
  results.push(await sample("warmup-shared", shared));
  for (const [i, env] of separate.entries()) { results.push(await sample(`warmup-separate-${String(i)}`, env)); }
  assert.ok(results.every(result => result.opened), "Preparation failed; cannot label later starts warm");
  const version = results[0]?.version; assert.ok(version !== undefined);
  for (const mode of ["shared", "separate", "serial", "recovery", "guarded", "adapter", "cold", "cold-gated", "cold-adapter"] as const) {
    if (!selection.split(",").includes(mode)) { continue; }
    let gate: "none" | "probe" | "oar" = "none";
    if (mode === "cold-gated") { gate = "oar"; }
    else if (mode === "guarded") { gate = "probe"; }
    for (let round = 0; round < rounds; round++) {
      const cold = mode.startsWith("cold");
      const names = (cold ? [0, 1, 2, 3] : [0, 1]).map(i => `${mode}-${String(round)}-${String(i)}`);
      const roundEnv = cold ? await environment(`${mode}-${String(round)}`) : shared;
      if (cold) {
        const root = roundEnv.XDG_DATA_HOME; assert.ok(root !== undefined);
        await assert.rejects(stat(path.join(root, "opencode")), { code: "ENOENT" }, "Cold data directory must not exist before the concurrent starts");
      }
      if ((mode === "recovery" || mode === "guarded" || mode === "adapter")) {
        const writer = spawn("python3", ["-c", "import sqlite3,os,sys; c=sqlite3.connect(sys.argv[1]); c.execute('PRAGMA wal_autocheckpoint=0'); c.execute('CREATE TABLE IF NOT EXISTS oar_probe (v BLOB)'); c.execute('DELETE FROM oar_probe'); c.execute('INSERT INTO oar_probe VALUES (zeroblob(67108864))'); c.commit(); os._exit(0)", path.join(data, "opencode", "opencode.db")], { stdio: ["ignore", "ignore", "inherit"] });
        await new Promise<void>((resolve, reject) => { writer.on("error", reject); writer.on("exit", code => { if (code === 0) { resolve(); } else { reject(new Error(`Writer exit ${String(code)}`)); } }); });
      }
      if (mode === "adapter" || mode === "cold-adapter") {
        const { adapterSample } = await import("./adapter.js");
        results.push(...await Promise.all(names.map(async name => { const result = await adapterSample({ command, version, env: roundEnv, name, output }); return result; })));
      } else if (mode === "serial") {
        for (const name of names) { results.push(await sample(name, shared)); }
      } else { results.push(...await Promise.all(names.map(async (name, i) => { const env = mode === "separate" ? separate[i] : roundEnv; assert.ok(env !== undefined); const result = await sample(name, env, gate); return result; }))); }
    }
  }
} finally {
  await new Promise<void>((resolve, reject) => { server.close(error => { if (error) { reject(error); } else { resolve(); } }); });
  await writeFile(path.join(output, "report.json"), `${JSON.stringify({ platform: process.platform, node: process.version, command, nativeArgs, rounds, shutdown, selection, providerRequests, results }, null, 2)}\n`);
}
process.exitCode = providerRequests.length > 0 || results.some(result => !result.opened || (result.adapter === true ? result.cleanup !== true : result.exitCode !== 0 && !(shutdown === "term" && result.signal === "SIGTERM"))) ? 1 : 0;
