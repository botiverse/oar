import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveRunDir } from "../../harness/trace.js";
import { environmentValue } from "../../../packages/oar/src/shared/environment.js";
import { alive, fixtureIdentityPath, reportedProcess, type ProcessIdentity } from "../../../tests/fixtures/process-tree.js";

interface BrowserExecution { readonly file: string; readonly observer: ProcessIdentity; readonly child?: BrowserChild; readonly code?: number | null }
interface BrowserChild { readonly pid: number; readonly start: string | null }
interface ObserverExit { readonly observer: ProcessIdentity; readonly code: number }
interface KimiLoginFixture {
  readonly dir: string; readonly home: string; readonly origin: string; readonly controlBrowser: string;
  readonly requests: readonly { method: string; path: string }[];
  readonly env: Readonly<Record<string, string | null>>;
  executions(): Promise<readonly BrowserExecution[]>;
  observerExits(): Promise<readonly ObserverExit[]>;
  processRunning(child: BrowserChild): boolean;
  dispose(): Promise<void>;
}

function parseExecution(line: string): BrowserExecution {
  const parsed: unknown = JSON.parse(line);
  assert.ok(typeof parsed === "object" && parsed !== null && "file" in parsed && typeof parsed.file === "string");
  assert.ok("observer" in parsed);
  const child = "pid" in parsed && typeof parsed.pid === "number" && "start" in parsed && (parsed.start === null || typeof parsed.start === "string")
    ? { pid: parsed.pid, start: parsed.start } : undefined;
  return { file: parsed.file, observer: reportedProcess(parsed.observer), ...(child === undefined ? {} : { child }), ...("code" in parsed && (typeof parsed.code === "number" || parsed.code === null) ? { code: parsed.code } : {}) };
}

function parseObserverExit(line: string): ObserverExit {
  const parsed: unknown = JSON.parse(line);
  assert.ok(typeof parsed === "object" && parsed !== null && "observer" in parsed && "code" in parsed && typeof parsed.code === "number");
  return { observer: reportedProcess(parsed.observer), code: parsed.code };
}

/** Real Kimi, synthetic local OAuth and models, isolated credentials and browser commands. */
export async function kimiLoginFixture(mode: "success" | "pending" | "denied" | "models-failed" | "account-usage" = "success"): Promise<KimiLoginFixture> {
  const dir = await mkdtemp(path.join(tmpdir(), "oar-kimi-native-login-"));
  const home = path.join(dir, "home");
  const helpers = path.join(dir, "browser");
  await mkdir(home); await mkdir(helpers);
  const browserName = process.platform === "win32" ? "powershell.exe" : (process.platform === "darwin" ? "open" : "xdg-open");
  const controlBrowser = path.join(helpers, browserName);
  await (process.platform === "win32"
    ? copyFile(path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, "System32", "hostname.exe"), controlBrowser)
    : writeFile(controlBrowser, "#!/bin/sh\nexit 0\n", { mode: 0o700 }));
  // These callbacks live inside Kimi and may disappear when it calls process.exit.
  // Record paths and process metadata, never OAuth arguments, headers or env values.
  const preload = path.join(dir, "observe.cjs");
  const executions = path.join(dir, "executions.jsonl");
  const exits = path.join(dir, "observer-exits.jsonl");
  const processes: { pid: number; running: boolean }[] = [];
  await writeFile(preload, `const cp = require('node:child_process');
const fs = require('node:fs');
const { captureProcess, processStart } = require(${JSON.stringify(fixtureIdentityPath)});
const observer = captureProcess(process.pid);
const log = value => fs.appendFileSync(process.env.OAR_KIMI_EXEC_LOG, JSON.stringify({...value, observer})+'\\n');
process.on('exit', code => fs.appendFileSync(process.env.OAR_KIMI_EXIT_LOG, JSON.stringify({observer, code})+'\\n'));
const original = cp.execFile;
cp.execFile = function(file, ...args) {
  const child = Reflect.apply(original, this, [file, ...args]);
  log({file, pid:child.pid, start:child.pid === undefined ? null : processStart(child.pid) ?? null});
  child.on('exit', (code, signal) => log({file, code, signal}));
  return child;
};
require('node:module').syncBuiltinESMExports();
`);
  const requests: { method: string; path: string }[] = [];
  let origin = "";
  let grants = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    requests.push({ method: request.method ?? "", path: url.pathname });
    request.resume();
    let status = 200; let body: unknown = { error: "unexpected request" };
    if (url.pathname === "/api/oauth/device_authorization") {
      body = { device_code: "synthetic-device", user_code: "OAR-CODE", verification_uri: `${origin}/device`, verification_uri_complete: `${origin}/device?code=OAR-CODE`, expires_in: 600, interval: 1 };
    } else if (url.pathname === "/api/oauth/token") {
      if (mode === "pending" || mode === "denied") { status = 400; body = { error: mode === "pending" ? "authorization_pending" : "access_denied" }; }
      else { grants += 1; body = { access_token: mode === "account-usage" && grants > 1 ? "synthetic-access-b" : "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600, token_type: "Bearer" }; }
    } else if (url.pathname === "/models") {
      if (mode === "models-failed") { status = 500; body = { error: { message: "synthetic provisioning failure" } }; }
      else { body = { data: [{ id: "synthetic-model", display_name: "Synthetic model", limit: { context: 32_768 }, protocol: "anthropic" }] }; }
    } else if (mode === "account-usage" && (url.pathname === "/usages" || url.pathname === "/me")) {
      const account = request.headers.authorization === "Bearer synthetic-access" ? "A"
        : (request.headers.authorization === "Bearer synthetic-access-b" ? "B" : null);
      if (account === null) { status = 401; body = { error: "unknown synthetic account" }; }
      else { body = url.pathname === "/usages"
        ? { usages: { limit_7d: { used_ratio: account === "A" ? 1 : 0.25 } }, usage: { used: account === "A" ? "100" : "25", limit: "100" } }
        : { user_id: `synthetic-${account}`, nickname: `Fixture ${account}`, user_level_name: "Synthetic" }; }
    } else { status = 404; body = { error: "unexpected request" }; }
    response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address !== null && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
  async function readExecutions(): Promise<readonly BrowserExecution[]> {
    const content = await readFile(executions, "utf8").catch(() => "");
    return content.trim() === "" ? [] : content.trim().split("\n").map((line) => parseExecution(line));
  }
  async function readObserverExits(): Promise<readonly ObserverExit[]> {
    const content = await readFile(exits, "utf8").catch(() => "");
    return content.trim() === "" ? [] : content.trim().split("\n").map((line) => parseObserverExit(line));
  }
  return {
    dir, home, origin, requests, controlBrowser,
    env: {
      KIMI_CODE_HOME: home, KIMI_CODE_OAUTH_HOST: origin, KIMI_CODE_BASE_URL: origin,
      KIMI_DISABLE_TELEMETRY: "1", KIMI_CODE_API_KEY: null, KIMI_API_KEY: null, MOONSHOT_API_KEY: null,
      PATH: helpers + path.delimiter + (environmentValue(process.env, "PATH") ?? ""),
      NODE_OPTIONS: `--require ${JSON.stringify(preload)}`, OAR_KIMI_EXEC_LOG: executions, OAR_KIMI_EXIT_LOG: exits,
    },
    executions: readExecutions,
    observerExits: readObserverExits,
    processRunning({ pid, start }): boolean {
      // Observe from the surviving test process, independently of Kimi's event loop.
      const running = start !== null && alive({ pid, start });
      processes.push({ pid, running });
      return running;
    },
    async dispose(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) { reject(error); } else { resolve(); } }); });
      const evidence = path.join(resolveRunDir(), "kimi-login");
      await mkdir(evidence, { recursive: true });
      await writeFile(path.join(evidence, `${path.basename(dir)}.json`), JSON.stringify({ platform: process.platform, mode, requests, executions: await readExecutions(), observerExits: await readObserverExits(), processes }, null, 2));
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}
