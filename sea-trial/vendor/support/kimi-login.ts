import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveRunDir } from "../../harness/trace.js";
import { environmentValue } from "../../../packages/oar/src/shared/environment.js";

interface BrowserExecution { readonly file: string; readonly pid?: number; readonly code?: number | null }
interface KimiLoginFixture {
  readonly dir: string; readonly home: string; readonly origin: string; readonly controlBrowser: string;
  readonly requests: readonly { method: string; path: string }[];
  readonly env: Readonly<Record<string, string | null>>;
  executions(): Promise<readonly BrowserExecution[]>;
  dispose(): Promise<void>;
}

function parseExecution(line: string): BrowserExecution {
  const parsed: unknown = JSON.parse(line);
  assert.ok(typeof parsed === "object" && parsed !== null && "file" in parsed && typeof parsed.file === "string");
  return { file: parsed.file, ...("pid" in parsed && typeof parsed.pid === "number" ? { pid: parsed.pid } : {}), ...("code" in parsed && (typeof parsed.code === "number" || parsed.code === null) ? { code: parsed.code } : {}) };
}

/** Real Kimi, synthetic local OAuth and models, isolated credentials and browser commands. */
export async function kimiLoginFixture(mode: "success" | "pending" | "denied" | "models-failed" = "success"): Promise<KimiLoginFixture> {
  const dir = await mkdtemp(path.join(tmpdir(), "oar-kimi-native-login-"));
  const home = path.join(dir, "home");
  const helpers = path.join(dir, "browser");
  await mkdir(home); await mkdir(helpers);
  const browserName = process.platform === "win32" ? "powershell.exe" : (process.platform === "darwin" ? "open" : "xdg-open");
  const controlBrowser = path.join(helpers, browserName);
  await (process.platform === "win32"
    ? copyFile(path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, "System32", "hostname.exe"), controlBrowser)
    : writeFile(controlBrowser, "#!/bin/sh\nexit 0\n", { mode: 0o700 }));
  // Observe the original execFile call and its exit without replacing it. Record
  // executable paths only, never OAuth arguments, headers or environment values.
  const preload = path.join(dir, "observe.cjs");
  const executions = path.join(dir, "executions.jsonl");
  await writeFile(preload, `const cp = require('node:child_process');
const fs = require('node:fs');
const log = value => fs.appendFileSync(process.env.OAR_KIMI_EXEC_LOG, JSON.stringify(value)+'\\n');
const original = cp.execFile;
cp.execFile = function(file, ...args) {
  const child = Reflect.apply(original, this, [file, ...args]);
  log({file, pid:child.pid});
  child.on('exit', (code, signal) => log({file, code, signal}));
  return child;
};
require('node:module').syncBuiltinESMExports();
`);
  const requests: { method: string; path: string }[] = [];
  let origin = "";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    requests.push({ method: request.method ?? "", path: url.pathname });
    request.resume();
    let status = 200; let body: unknown = { error: "unexpected request" };
    if (url.pathname === "/api/oauth/device_authorization") {
      body = { device_code: "synthetic-device", user_code: "OAR-CODE", verification_uri: `${origin}/device`, verification_uri_complete: `${origin}/device?code=OAR-CODE`, expires_in: 600, interval: 1 };
    } else if (url.pathname === "/api/oauth/token") {
      if (mode === "pending" || mode === "denied") { status = 400; body = { error: mode === "pending" ? "authorization_pending" : "access_denied" }; }
      else { body = { access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600, token_type: "Bearer" }; }
    } else if (url.pathname === "/models") {
      if (mode === "models-failed") { status = 500; body = { error: { message: "synthetic provisioning failure" } }; }
      else { body = { data: [{ id: "synthetic-model", display_name: "Synthetic model", limit: { context: 32_768 }, protocol: "anthropic" }] }; }
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
  return {
    dir, home, origin, requests, controlBrowser,
    env: {
      KIMI_CODE_HOME: home, KIMI_CODE_OAUTH_HOST: origin, KIMI_CODE_BASE_URL: origin,
      KIMI_DISABLE_TELEMETRY: "1", KIMI_CODE_API_KEY: null, KIMI_API_KEY: null, MOONSHOT_API_KEY: null,
      PATH: helpers + path.delimiter + (environmentValue(process.env, "PATH") ?? ""),
      NODE_OPTIONS: `--require ${JSON.stringify(preload)}`, OAR_KIMI_EXEC_LOG: executions,
    },
    executions: readExecutions,
    async dispose(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) { reject(error); } else { resolve(); } }); });
      const evidence = path.join(resolveRunDir(), "kimi-login");
      await mkdir(evidence, { recursive: true });
      await writeFile(path.join(evidence, `${path.basename(dir)}.json`), JSON.stringify({ platform: process.platform, mode, requests, executions: await readExecutions() }, null, 2));
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}
