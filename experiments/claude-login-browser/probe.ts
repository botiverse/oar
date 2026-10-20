/**
 * Real Claude, synthetic OAuth: pnpm tsx experiments/claude-login-browser/probe.ts /absolute/claude VERSION
 * Run on disposable macOS/Windows runners and an isolated Linux configuration.
 * Requires openssl. No account or model request, no proxy forwarding, no global
 * environment or trust-store changes. Only counts and route names are printed.
 */
import assert from "node:assert/strict";
import { execFileSync, fork, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mockOAuth } from "./mock.js";

const args = process.argv.slice(2);
const command = args[0] === "--package" && args[1] !== undefined
  ? path.resolve(args[1], "node_modules", "@anthropic-ai", `claude-code-${process.platform}-${process.arch}`, process.platform === "win32" ? "claude.exe" : "claude")
  : args[0];
const version = args[0] === "--package" ? args[2] : args[1];
assert.ok(command !== undefined && path.isAbsolute(command) && version !== undefined, "pass an absolute Claude binary and its version");
const root = mkdtempSync(path.join(tmpdir(), "oar-login-browser-"));
const keyFile = path.join(root, "key.pem");
const certFile = path.join(root, "cert.pem");
const certConfig = path.join(root, "openssl.cnf");
writeFileSync(certConfig, `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=OAR local OAuth probe\n[ext]\nbasicConstraints=critical,CA:TRUE\nsubjectAltName=DNS:api.anthropic.com,DNS:platform.claude.com,DNS:console.anthropic.com,DNS:claude.ai,DNS:claude.com,DNS:api.claude.com\n`);
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", certConfig,
  "-keyout", keyFile, "-out", certFile], { stdio: "ignore" });

async function closed(child: ChildProcess): Promise<number | null> {
  const exit = Promise.withResolvers<number | null>();
  child.once("error", exit.reject);
  child.once("close", exit.resolve);
  const code = await exit.promise;
  return code;
}

async function run(mode: "default" | "suppressed"): Promise<void> {
  assert.ok(command !== undefined && version !== undefined);
  const home = path.join(root, mode);
  const bin = path.join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const marker = path.join(home, "browser-opened");
  const browser = path.join(bin, process.platform === "win32" ? "browser-probe.exe" : "browser-probe");
  // BROWSER points to a harmless positive control. Guard the platform's
  // fallback too, so a regression cannot start a GUI browser on the runner.
  if (process.platform === "win32") {
    const source = path.join(home, "browser.cs");
    writeFileSync(source, String.raw`using System; using System.IO; class Browser { static void Main() { File.AppendAllText(Environment.GetEnvironmentVariable("OAR_LOGIN_BROWSER_MARKER"), "opened\n"); } }`);
    const compiler = path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    execFileSync(compiler, ["/nologo", "/target:exe", `/out:${browser}`, source], { stdio: "pipe" });
    copyFileSync(browser, path.join(bin, "rundll32.exe"));
  } else {
    const script = `#!/bin/sh\nprintf 'opened\\n' >> '${marker.replaceAll("'", String.raw`'\''`)}'\n`;
    for (const name of ["browser-probe", "xdg-open", "open"]) { writeFileSync(path.join(bin, name), script, { mode: 0o755 }); }
  }
  const mock = await mockOAuth(readFileSync(keyFile), readFileSync(certFile));
  try {
    const env: NodeJS.ProcessEnv = {};
    // No inherited authentication, configuration, proxy, or Claude markers.
    for (const name of ["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TMP", "TEMP", "TMPDIR"]) {
      if (process.env[name] !== undefined) { env[name] = process.env[name]; }
    }
    Object.assign(env, {
      PATH: `${bin}${path.delimiter}${env.PATH ?? ""}`,
      HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"),
      APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"),
      HTTPS_PROXY: mock.url, HTTP_PROXY: mock.url, ALL_PROXY: mock.url, NO_PROXY: "localhost,127.0.0.1",
      NODE_EXTRA_CA_CERTS: certFile, OAR_LOGIN_BROWSER_MARKER: marker,
      BROWSER: browser, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
    });
    if (process.platform === "win32" && mode === "suppressed") {
      const executable = path.join(env.SystemRoot ?? String.raw`C:\Windows`, "System32", "ipconfig.exe");
      const noOp = spawn(executable, ["https://example.invalid/login?state=probe&next=ignored"], { env, stdio: "pipe", windowsHide: true });
      // Keep stdin open: a command that reads it would hang and fail this check.
      const timer = setTimeout(() => { noOp.kill(); }, 5000);
      const exit = await closed(noOp);
      clearTimeout(timer);
      assert.equal(exit, 0, "Windows no-op must exit successfully without reading stdin");
    }
    const observed: { result?: Record<string, unknown> } = {};
    const child = fork(fileURLToPath(new URL("child.ts", import.meta.url)), [command, version, mode], {
      env, cwd: home, execArgv: ["--import", import.meta.resolve("tsx")],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let diagnostic = "";
    child.stderr?.on("data", (chunk: Buffer) => { diagnostic += chunk.toString("utf8"); });
    child.on("message", (message: unknown) => {
      if (typeof message !== "object" || message === null || !("kind" in message)) { return; }
      if (message.kind === "authorization" && "state" in message && typeof message.state === "string"
        && "challenge" in message && typeof message.challenge === "string") {
        mock.expect({ state: message.state, challenge: message.challenge });
      } else if (message.kind === "result") {
        observed.result = { ...message };
      }
    });
    const exit = await closed(child);
    const opens = existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").length : 0;
    const { result } = observed;
    const row = { platform: process.platform, version, mode, exit, result, browserOpens: opens, ...mock.seen };
    console.log(JSON.stringify(row));
    assert.equal(exit, 0, diagnostic);
    assert.equal(result?.login, "logged_in");
    assert.equal(result.status, "logged_in");
    assert.equal(result.urls, 1);
    assert.equal(result.prompts, 1);
    assert.equal(opens, mode === "default" ? 1 : 0);
    assert.equal(mock.seen.exchanges, 1);
    assert.equal(mock.seen.verified, true);
  } finally {
    await mock.close();
  }
}
try {
  await run("default");
  await run("suppressed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
