/* oxlint-disable import/max-dependencies, typescript/promise-function-async, eslint/no-await-in-loop -- One transferable entry retains both protocol and public-session observations. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { antigravitySession, promptAndWait, type Session } from "../../packages/oar/src/index.js";
import { antigravityAcpArgs } from "../../packages/oar/src/runtimes/antigravity/session.js";
import { createAcpClientApp } from "../../packages/oar/src/shared/acp/client-app.js";
import { startAcpProcess, withAcpDeadline } from "../../packages/oar/src/shared/acp/process.js";
import { createAcpTerminalHost } from "../../packages/oar/src/shared/acp/terminal.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";

const entry = import.meta.filename;
const tsx = import.meta.resolve("tsx");
const secrets = Object.entries(process.env).filter(([key, value]) => /token|secret|password|api.?key|credential/iu.test(key) && value !== undefined && value.length >= 8).map(([, value]) => value ?? "");
function safe(text: string): string {
  let result = text;
  for (const value of secrets) { result = result.replaceAll(value, "[credential removed]"); }
  return result.replaceAll(/Bearer\s+[^\s"\\]+/giu, "Bearer [removed]")
    .replaceAll(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, "[jwt removed]")
    .replaceAll(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/giu, "[email removed]");
}
function json(value: unknown): string {
  return safe(JSON.stringify(value, (key, item: unknown): unknown => /^(?:access_?token|refresh_?token|id_?token|authorization|password|api_?key|client_?secret)$/iu.test(key) ? "[credential removed]" : item));
}
function log(file: string, kind: string, body: unknown): void {
  appendFileSync(file, `${json({ at: new Date().toISOString(), kind, body })}\n`, { mode: 0o600 });
}
function quote(value: string): string { return `'${value.replaceAll("'", String.raw`'\''`)}'`; }
async function bound<T>(operation: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined = undefined;
  try {
    const expiry = Promise.withResolvers<never>();
    timer = setTimeout(() => { expiry.reject(new Error(`${label} observation deadline (${String(ms)}ms)`)); }, ms);
    return await Promise.race([operation, expiry.promise]);
  } finally { clearTimeout(timer); }
}
async function readWire(file: string): Promise<unknown[]> {
  try { const content = await readFile(file, "utf8"); return content.trim().split("\n").filter(Boolean).map((line): unknown => JSON.parse(line)); }
  catch (error) { return [{ evidenceReadError: safe(String(error)) }]; }
}

// Tee complete JSON lines without altering bytes delivered to either peer.
// Both routes use this wrapper. No credentials or native auth files are read.
async function bridge(binary: string, file: string, args: string[]): Promise<void> {
  const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
  log(file, "spawn", { pid: child.pid, args });
  const tap = (source: NodeJS.ReadableStream, direction: string): void => {
    const lines = createInterface({ input: source });
    lines.on("line", line => {
      let body: unknown = line;
      try { body = JSON.parse(line); } catch { /* Retain malformed native lines too. */ }
      log(file, direction, body);
    });
  };
  tap(process.stdin, "to_native"); tap(child.stdout, "from_native"); tap(child.stderr, "stderr");
  process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  child.stdin.on("error", error => { log(file, "stdin_error", String(error)); });
  child.on("error", error => { log(file, "spawn_error", String(error)); });
  const terminate = (): void => { child.kill("SIGTERM"); };
  process.on("SIGTERM", terminate);
  const { promise, resolve } = Promise.withResolvers<void>();
  child.on("close", (code, signal) => {
    log(file, "native_exit", { code, signal }); process.exitCode = code ?? 1;
    process.stdin.unpipe(child.stdin); process.stdin.destroy(); resolve();
  });
  await promise;
  process.off("SIGTERM", terminate);
}
async function wrapper(directory: string, binary: string, wire: string): Promise<string> {
  const filename = path.join(directory, `${path.basename(wire)}.sh`);
  await writeFile(filename, `#!/bin/sh\nexec ${quote(process.execPath)} --import ${quote(tsx)} ${quote(entry)} --bridge ${quote(binary)} ${quote(wire)} "$@"\n`, { mode: 0o700 });
  return filename;
}

interface RouteOptions { readonly command: string; readonly cwd: string; readonly model: string; readonly effort: string; readonly prompt: string; readonly limit: number }
async function direct({ command, cwd, model, effort, prompt, limit }: RouteOptions): Promise<unknown> {
  const observed: unknown[] = [];
  const terminal = createAcpTerminalHost(cwd, process.env);
  const client = createAcpClientApp(terminal, {
    update: value => { observed.push(value); }, requested: () => {}, answered: () => {}, extension: () => {}, extensionNotifications: [],
  });
  const runtime = startAcpProcess(command, antigravityAcpArgs(), client, { cwd, redact: safe });
  let sessionId: string | undefined = undefined;
  let result: unknown = undefined;
  let failure: string | undefined = undefined;
  const cleanup: unknown[] = [];
  try {
    const call = (method: string, params: Record<string, unknown>, ms = 30_000): Promise<unknown> => withAcpDeadline(runtime, method, ms, options => runtime.connection.agent.request(method, params, options));
    await call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: true }, clientInfo: { name: "oar", version: "0.0.0" } });
    const opened = asRecord(await call("session/new", { cwd, mcpServers: [] }));
    assert.ok(typeof opened?.sessionId === "string", "session/new must return a sessionId");
    ({ sessionId } = opened);
    const configuration = asRecord(await call("session/set_config_option", { sessionId, configId: "model", value: model }));
    const options = configuration?.configOptions;
    assert.ok(Array.isArray(options), "native configuration response missing options");
    assert.ok(options.some((option: unknown) => { const record = asRecord(option); return record?.id === "model" && record.currentValue === model; }), `native model response did not confirm ${model}`);
    const thinking = options.map((option: unknown) => asRecord(option)).find(option => option?.category === "thought_level");
    assert.ok(typeof thinking?.id === "string", "native configuration omitted thought_level option");
    const thinkingResponse = asRecord(await call("session/set_config_option", { sessionId, configId: thinking.id, value: effort }));
    const thinkingOptions = thinkingResponse?.configOptions;
    assert.ok(Array.isArray(thinkingOptions), "native thought-level response missing options");
    assert.ok(thinkingOptions.some((option: unknown) => { const record = asRecord(option); return record?.category === "thought_level" && record.currentValue === effort; }), `native thought-level response did not confirm ${effort}`);
    assert.ok(thinkingOptions.some((option: unknown) => { const record = asRecord(option); return record?.id === "model" && record.currentValue === model; }), "setting effort changed the native model");
    result = await call("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] }, limit);
  } catch (error) { failure = safe(String(error)); }
  finally {
    if (sessionId !== undefined) {
      try { await bound(runtime.connection.agent.notify("session/cancel", { sessionId }), 2000, "direct cancel"); }
      catch (error) { cleanup.push(safe(String(error))); }
    }
    runtime.kill();
    try { await bound(runtime.exited, 15_000, "direct exit"); } catch (error) { cleanup.push(safe(String(error))); }
    try { await bound(terminal.dispose(), 15_000, "direct terminal cleanup"); } catch (error) { cleanup.push(safe(String(error))); }
  }
  return { result, error: failure, observed, cleanup, wrapperExitCode: runtime.exitCode, diagnostics: runtime.diagnostics() };
}
async function throughOar({ command, cwd, model, effort, prompt, limit }: RouteOptions): Promise<unknown> {
  let session: Session | undefined = undefined;
  let result: unknown = undefined;
  let failure: string | undefined = undefined;
  let cleanupError: string | undefined = undefined;
  try {
    session = await antigravitySession({ kind: "available", via: "executable", command }, { cwd, model, effort });
    result = await bound(promptAndWait(session, prompt), limit, "OAR prompt");
  } catch (error) { failure = safe(String(error)); }
  finally {
    if (session !== undefined) {
      try { await bound(session.dispose(), 20_000, "OAR dispose"); }
      catch (error) { cleanupError = safe(String(error)); }
    }
  }
  return { result, error: failure, cleanupError, records: session?.records(), status: session?.status() };
}

interface Measurement { readonly binary: string; readonly video: string; readonly model: string; readonly effort: string; readonly output: string; readonly limit: number }
async function measure({ binary, video, model, effort, output, limit }: Measurement): Promise<void> {
  assert.ok(process.platform !== "win32", "This handoff targets POSIX hosts");
  assert.ok(path.isAbsolute(binary) && path.isAbsolute(video) && path.isAbsolute(output));
  assert.ok(Number.isFinite(limit) && limit > 0 && limit <= 600_000);
  const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 8000 });
  assert.equal(version.status, 0, `version command failed: ${safe(version.stderr)}`);
  const bytes = await readFile(video);
  const cwd = path.dirname(video);
  const prompt = `Use your native read_file tool exactly once to read the video at ${video}. Then describe what you saw and heard. If the tool fails, report its original error. Do not extract frames, transcode, call ffmpeg, use a shell, or substitute another file.`;
  await mkdir(path.dirname(output), { recursive: true });
  const directory = await mkdtemp(path.join(os.tmpdir(), "oar-video-probe-"));
  await chmod(directory, 0o700);
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), version: safe(version.stdout.trim()), video: { path: video, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, model, effort, cwd, prompt, limitMs: limit, evidenceDirectory: directory, routes: [] };
  const routes: unknown[] = [];
  report.routes = routes;
  for (const route of ["direct_acp", "oar"] as const) {
    const wire = path.join(directory, `${route}.jsonl`);
    const command = await wrapper(directory, binary, wire);
    const startedAt = new Date().toISOString();
    const result = route === "direct_acp" ? await direct({ command, cwd, model, effort, prompt, limit }) : await throughOar({ command, cwd, model, effort, prompt, limit });
    const frames = await readWire(wire);
    const nativeExit = frames.findLast(frame => asRecord(frame)?.kind === "native_exit");
    routes.push({ route, startedAt, endedAt: new Date().toISOString(), result, nativeExit: nativeExit ?? { observed: false, reason: "No native exit callback was retained; wrapper exit is separate evidence" }, wire: frames });
    await writeFile(output, json(report), { mode: 0o600 });
    await chmod(output, 0o600);
  }
  console.log(JSON.stringify({ output, evidenceDirectory: directory }));
}

// Synthetic control only: it never starts agy or contacts a model provider.
const send = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };
async function fixture(mode: string): Promise<void> {
  if (process.argv.includes("--version")) { console.log("1.5.9 synthetic ACP fixture"); return; }
  const option = { id: "model", name: "Model", category: "model", type: "select", currentValue: "probe-model", options: [{ value: "probe-model", name: "Probe" }] };
  const thinking = { id: "thought_level", name: "Thinking", category: "thought_level", type: "select", currentValue: "low", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] };
  const input = createInterface({ input: process.stdin });
  input.on("line", line => {
    const message = asRecord(JSON.parse(line));
    if (message === null) { return; }
    const params = asRecord(message.params);
    let result: unknown = {};
    switch (message.method) {
      case "initialize": result = { protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: {} }, authMethods: [] }; break;
      case "session/new": result = { sessionId: "fixture-session", configOptions: [option, thinking] }; break;
      case "session/set_config_option":
        if (params?.configId === "thought_level") { thinking.currentValue = mode === "effort-refuse" ? "low" : String(params.value); }
        else if (mode === "refuse") { option.currentValue = "different-model"; }
        else if (typeof params?.value === "string") { option.currentValue = params.value; }
        result = { configOptions: [option, thinking] };
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "config_option_update", configOptions: [option, thinking] } } }); break;
      case "session/prompt":
        if (mode === "stall") { return; }
        if (mode === "500") { send({ jsonrpc: "2.0", id: message.id, error: { code: -32_603, message: "synthetic read_file HTTP 500" } }); return; }
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "SYNTHETIC_VIDEO_RESULT" } } } });
        result = { stopReason: "end_turn" }; break;
      default: break;
    }
    if (message.id !== undefined) { send({ jsonrpc: "2.0", id: message.id, result }); }
  });
  const closed = Promise.withResolvers<void>();
  input.on("close", closed.resolve);
  await closed.promise;
}
async function selfTest(output: string): Promise<void> {
  await mkdir(output, { recursive: true });
  const video = path.join(output, "synthetic.mp4"); await writeFile(video, "synthetic fixture, not a video");
  for (const mode of ["success", "500", "stall", "refuse", "effort-refuse"]) {
    const binary = path.join(output, `${mode}.sh`);
    await writeFile(binary, `#!/bin/sh\nexec ${quote(process.execPath)} --import ${quote(tsx)} ${quote(entry)} --fixture ${quote(mode)} "$@"\n`, { mode: 0o700 });
    const file = path.join(output, `${mode}.json`);
    await measure({ binary, video, model: "probe-model", effort: "high", output: file, limit: mode === "stall" ? 200 : 5000 });
    const report = asRecord(JSON.parse(await readFile(file, "utf8")));
    assert.ok(Array.isArray(report?.routes));
    for (const raw of report.routes) {
      const route = asRecord(raw); const result = asRecord(route?.result);
      assert.ok(Array.isArray(route?.wire) && route.wire.length > 0);
      if (mode === "success") { assert.equal(result?.error, undefined, json(result)); }
      if (mode === "500") { assert.ok(JSON.stringify(route.wire).includes("synthetic read_file HTTP 500")); }
      if (mode === "stall" || mode === "refuse" || mode === "effort-refuse") { assert.equal(typeof result?.error, "string"); }
      assert.equal(result?.cleanupError, undefined, json(result));
    }
  }
  await delay(100);
  console.log("Synthetic transport, refusal, failure and timeout controls passed");
}
const [mode, ...args] = process.argv.slice(2);
if (mode === "--bridge") {
  const [binary, file, ...nativeArgs] = args; assert.ok(binary !== undefined && file !== undefined); await bridge(binary, file, nativeArgs);
} else if (mode === "--fixture") { await fixture(args[0] ?? "success"); }
else if (mode === "--self-test") { assert.ok(args[0] !== undefined); await selfTest(path.resolve(args[0])); }
else {
  const [video, model, effort, output, seconds = "180"] = args;
  assert.ok(mode !== undefined && video !== undefined && model !== undefined && effort !== undefined && output !== undefined, "Usage: probe.ts /absolute/agy /absolute/video model effort /absolute/output.json [seconds]");
  await measure({ binary: mode, video, model, effort, output, limit: Number(seconds) * 1000 });
}
