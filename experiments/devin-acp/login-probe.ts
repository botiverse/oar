/**
 * Real Devin CLI against an in-process synthetic PKCE and ConnectRPC server.
 * Runs inside an isolated temporary HOME with browser launch blocked.
 * Prints only route counts and boolean verification outcomes, with no paths or tokens.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { parseDevinAuthStatus } from "../../packages/oar/src/runtimes/devin/auth.js";

const SYNTHETIC_AUTH_CODE = "synthetic-pkce-authorization-code";
const VALID_RAW_TOKEN = "synthetic-valid-session";
const REJECTED_RAW_TOKEN = "synthetic-rejected-session";
const VALID_STORED_KEY = `devin-session-token$${VALID_RAW_TOKEN}`;
const REJECTED_STORED_KEY = `devin-session-token$${REJECTED_RAW_TOKEN}`;
const MACOS_SANDBOX_PROFILE = [
  "(version 1)",
  "(allow default)",
  "(deny lsopen)",
  '(deny mach-lookup (global-name-prefix "com.apple.coreservices.launchservices") (global-name-prefix "com.apple.lsd"))',
  '(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript"))',
].join("");

const DETACHED_NON_TTY_PYTHON = String.raw`
import os, subprocess, sys
cmd = sys.argv[1:]
proc = subprocess.Popen(
    cmd,
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    start_new_session=True,
)
out, err = proc.communicate(b"\x1b[1;1Rsynthetic-code\r\n", timeout=15)
sys.stdout.write(out.decode("utf-8", "replace"))
sys.stderr.write(err.decode("utf-8", "replace"))
sys.exit(proc.returncode if proc.returncode is not None else 1)
`;

const PTY_LOGIN_PYTHON = String.raw`
import json, os, pty, re, select, struct, fcntl, termios, time, urllib.parse, urllib.request, sys

expect_url = sys.argv[1]
code_to_paste = sys.argv[2]
cmd = sys.argv[3:]

master_fd, slave_fd = pty.openpty()
winsize = struct.pack("HHHH", 30, 120, 0, 0)
fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, winsize)

pid = os.fork()
if pid == 0:
    os.setsid()
    os.close(master_fd)
    fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
    os.dup2(slave_fd, 0)
    os.dup2(slave_fd, 1)
    os.dup2(slave_fd, 2)
    if slave_fd > 2:
        os.close(slave_fd)
    os.execvp(cmd[0], cmd)

os.close(slave_fd)
buf = bytearray()
sent_code = False
responded_cpr = 0
deadline = time.monotonic() + 20.0

while time.monotonic() < deadline:
    rlist, _, _ = select.select([master_fd], [], [], 0.1)
    if master_fd in rlist:
        try:
            chunk = os.read(master_fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        buf.extend(chunk)
        if b"\x1b[6n" in chunk and responded_cpr < 4:
            os.write(master_fd, b"\x1b[1;1R")
            responded_cpr += 1
        text = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", buf.decode("utf-8", "replace"))
        if not sent_code and "Code:" in text and "cli_pkce_marker=1" in text:
            compact = "".join(line.strip() for line in text.splitlines())
            match = re.search(r"(http://localhost:\d+/auth/cli/continue\?[A-Za-z0-9_=&%-]*cli_pkce_marker=1)", compact)
            if match is not None:
                parsed = urllib.parse.urlparse(match.group(1))
                qs = urllib.parse.parse_qs(parsed.query)
                payload = json.dumps({
                    "url": match.group(1),
                    "state": qs.get("state", [""])[0],
                    "challenge": qs.get("code_challenge", [""])[0],
                    "method": qs.get("code_challenge_method", [""])[0],
                    "marker": qs.get("cli_pkce_marker", [""])[0],
                }).encode("utf-8")
                req = urllib.request.Request(expect_url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
                with urllib.request.urlopen(req, timeout=5) as resp:
                    resp.read()
                time.sleep(0.1)
                os.write(master_fd, (code_to_paste + "\r").encode("utf-8"))
                sent_code = True
    wpid, status = os.waitpid(pid, os.WNOHANG)
    if wpid == pid:
        os.close(master_fd)
        code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1
        clean = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", buf.decode("utf-8", "replace"))
        sys.stdout.write(json.dumps({"exitCode": code, "sentCode": sent_code, "output": clean}))
        sys.exit(0)

os.close(master_fd)
reap_deadline = time.monotonic() + 2.0
while time.monotonic() < reap_deadline:
    wpid, status = os.waitpid(pid, os.WNOHANG)
    if wpid == pid:
        code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1
        clean = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", buf.decode("utf-8", "replace"))
        sys.stdout.write(json.dumps({"exitCode": code, "sentCode": sent_code, "output": clean}))
        sys.exit(0)
    time.sleep(0.05)

try:
    os.kill(pid, 9)
    os.waitpid(pid, 0)
except OSError:
    pass
clean = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", buf.decode("utf-8", "replace"))
sys.stderr.write("PTY login timed out; captured=" + clean[-400:])
sys.exit(2)
`;

interface CommandOutcome {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface ExpectedPkce {
  state: string;
  challenge: string;
  method: string;
  marker: string;
}

interface MockState {
  port: number;
  expected: ExpectedPkce | null;
  pkceVerified: boolean;
  browserPageLoads: number;
  tokenExchanges: number;
  healthChecks: number;
  userStatusOk: number;
  userStatusRejected: number;
  teamSettingsChecks: number;
}

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 128) {
    bytes.push((rest % 128) + 128);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

function encodeVarintField(fieldNumber: number, value: number): Buffer {
  return Buffer.concat([encodeVarint(fieldNumber * 8), encodeVarint(value)]);
}

function encodeBytesField(fieldNumber: number, payload: Buffer | string): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  return Buffer.concat([encodeVarint(fieldNumber * 8 + 2), encodeVarint(data.length), data]);
}

function buildGetUserStatusProto(): Buffer {
  const userStatus = Buffer.concat([
    encodeVarintField(2, 0),
    encodeBytesField(3, "Synthetic User"),
    encodeBytesField(5, "team-synthetic"),
    encodeVarintField(6, 2),
    encodeBytesField(7, "alice@example.test"),
    encodeVarintField(10, 1),
    encodeBytesField(36, "user-synthetic"),
  ]);
  const devinInfo = encodeBytesField(10, "org-synthetic");
  const planInfo = Buffer.concat([
    encodeBytesField(2, "Teams"),
    encodeBytesField(33, devinInfo),
  ]);
  return Buffer.concat([encodeBytesField(1, userStatus), encodeBytesField(2, planInfo)]);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const raw = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(raw.length),
    Connection: "close",
  });
  res.end(raw);
}

function sendProto(res: ServerResponse, payload: Buffer): void {
  res.writeHead(200, {
    "Content-Type": "application/proto",
    "Content-Length": String(payload.length),
    Connection: "close",
  });
  res.end(payload);
}

async function handleMockRequest(state: MockState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const urlPath = req.url ?? "/";
  const body = await readBody(req);

  if (req.method === "GET" && urlPath.startsWith("/auth/cli/continue")) {
    state.browserPageLoads += 1;
    sendJson(res, 200, { browser: "unexpected" });
    return;
  }
  if (req.method === "GET" && urlPath.startsWith("/api/healthz")) {
    state.healthChecks += 1;
    sendJson(res, 200, "OK");
    return;
  }
  if (req.method === "POST" && urlPath === "/__probe/expect") {
    const parsed = asObject(JSON.parse(body.toString("utf8")));
    state.expected = {
      state: typeof parsed?.state === "string" ? parsed.state : "",
      challenge: typeof parsed?.challenge === "string" ? parsed.challenge : "",
      method: typeof parsed?.method === "string" ? parsed.method : "",
      marker: typeof parsed?.marker === "string" ? parsed.marker : "",
    };
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "POST" && urlPath === "/auth/cli/token") {
    state.tokenExchanges += 1;
    const parsed = asObject(JSON.parse(body.toString("utf8")));
    const code = typeof parsed?.code === "string" ? parsed.code : "";
    const verifier = typeof parsed?.code_verifier === "string" ? parsed.code_verifier : "";
    const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
    if (state.expected === null || code !== SYNTHETIC_AUTH_CODE || challenge !== state.expected.challenge) {
      sendJson(res, 400, { error: "invalid_grant" });
      return;
    }
    state.pkceVerified = true;
    sendJson(res, 200, {
      token: VALID_RAW_TOKEN,
      webapp_host: `localhost:${String(state.port)}`,
    });
    return;
  }
  if (req.method === "POST" && urlPath.endsWith("/GetUserStatus")) {
    if (body.includes(Buffer.from(VALID_STORED_KEY, "utf8"))) {
      state.userStatusOk += 1;
      sendProto(res, buildGetUserStatusProto());
      return;
    }
    state.userStatusRejected += 1;
    sendJson(res, 401, {
      code: "unauthenticated",
      message: "Authentication required: invalid api key",
    });
    return;
  }
  if (req.method === "POST" && urlPath.endsWith("/GetCliTeamSettings")) {
    state.teamSettingsChecks += 1;
    sendProto(res, encodeVarintField(1, 1));
    return;
  }
  sendJson(res, 200, {});
}

async function startMockServer(): Promise<{ readonly server: Server; readonly state: MockState }> {
  const state: MockState = {
    port: 0,
    expected: null,
    pkceVerified: false,
    browserPageLoads: 0,
    tokenExchanges: 0,
    healthChecks: 0,
    userStatusOk: 0,
    userStatusRejected: 0,
    teamSettingsChecks: 0,
  };
  const listener = (req: IncomingMessage, res: ServerResponse): void => {
    void (async (): Promise<void> => {
      try {
        await handleMockRequest(state, req, res);
      } catch {
        sendJson(res, 500, { error: "mock server failure" });
      }
    })();
  };
  const server = createServer(listener);
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen({ port: 0, host: "::", ipv6Only: false }, listening.resolve);
  await listening.promise;
  const addr = server.address();
  assert.ok(addr !== null && typeof addr === "object", "expected bound TCP address");
  state.port = addr.port;
  return { server, state };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  const closed = Promise.withResolvers<void>();
  server.close(() => {
    closed.resolve();
  });
  await closed.promise;
}

function resolveDevinCommand(): string {
  const fromEnv = process.env.OAR_DEVIN_BIN;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  const whichName = process.platform === "win32" ? "where" : "which";
  const onPath = spawnSync(whichName, ["devin"], { encoding: "utf8" });
  if (onPath.status === 0 && onPath.stdout.trim().length > 0) {
    const [firstLine] = onPath.stdout.trim().split(/\r?\n/u);
    if (firstLine !== undefined && firstLine.length > 0) {
      return firstLine;
    }
  }
  return path.join(homedir(), ".local", "bin", process.platform === "win32" ? "devin.exe" : "devin");
}

function devinArgv(devinCommand: string, args: readonly string[]): readonly string[] {
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
    return ["/usr/bin/sandbox-exec", "-p", MACOS_SANDBOX_PROFILE, devinCommand, ...args];
  }
  return [devinCommand, ...args];
}

function createIsolatedEnv(home: string, binDir: string, port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TMP", "TEMP", "TMPDIR", "TERM"]) {
    const val = process.env[key];
    if (val !== undefined) {
      env[key] = val;
    }
  }
  const baseUrl = `http://localhost:${String(port)}`;
  return {
    ...env,
    PATH: `${binDir}${path.delimiter}${env.PATH ?? ""}`,
    BROWSER: path.join(binDir, "xdg-open"),
    HOME: home,
    USERPROFILE: home,
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    DEVIN_WEBAPP_URL: baseUrl,
    DEVIN_API_URL: baseUrl,
    WINDSURF_API_SERVER_URL: baseUrl,
    WINDSURF_WEBSITE_URL: baseUrl,
  };
}

async function runAsyncCommand(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<CommandOutcome> {
  const [executable, ...restArgs] = argv;
  assert.ok(executable !== undefined && executable.length > 0);
  const child = spawn(executable, restArgs, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const outcome = Promise.withResolvers<number | null>();
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    outcome.reject(new Error("Command timed out after 20000 ms"));
  }, 20_000);
  child.once("error", (err) => {
    clearTimeout(timer);
    outcome.reject(err);
  });
  child.once("close", (code) => {
    clearTimeout(timer);
    outcome.resolve(code);
  });
  const exitCode = await outcome.promise;
  return { exitCode, stdout, stderr };
}

function countLauncherIntercepts(markerFile: string): number {
  if (!existsSync(markerFile)) {
    return 0;
  }
  const lines = readFileSync(markerFile, "utf8").trim();
  if (lines.length === 0) {
    return 0;
  }
  return lines.split("\n").length;
}

async function main(): Promise<void> {
  const devinCommand = resolveDevinCommand();
  const rawRoot = mkdtempSync(path.join(tmpdir(), "oar-devin-login-probe-"));
  const root = realpathSync(rawRoot);
  const { server, state } = await startMockServer();
  try {
    const home = path.join(root, "home");
    const binDir = path.join(root, "bin");
    const markerFile = path.join(root, "launcher-intercepted");
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });

    const launcherScript = `#!/bin/sh\nprintf 'intercepted\\n' >> '${markerFile.replaceAll("'", String.raw`'\''`)}'\nexit 1\n`;
    for (const name of ["open", "xdg-open", "gio", "wslview"]) {
      writeFileSync(path.join(binDir, name), launcherScript, { mode: 0o755 });
    }

    const env = createIsolatedEnv(home, binDir, state.port);
    const versionRun = await runAsyncCommand(devinArgv(devinCommand, ["--version"]), env);
    assert.equal(versionRun.exitCode, 0);

    // Step a. Clean state starts logged out.
    const initialStatusRun = await runAsyncCommand(devinArgv(devinCommand, ["auth", "status"]), env);
    assert.equal(initialStatusRun.exitCode, 0);
    assert.match(initialStatusRun.stdout, /^Not logged in\./mu);
    const initialParsed = parseDevinAuthStatus(initialStatusRun.stdout);
    assert.equal(initialParsed.kind, "logged_out");

    // Step b. Detached setsid session without a controlling TTY fails to read code over pipes.
    const detachedRun = await runAsyncCommand(
      ["python3", "-c", DETACHED_NON_TTY_PYTHON, ...devinArgv(devinCommand, ["auth", "login", "--force-manual-token-flow"])],
      env,
    );
    assert.notEqual(detachedRun.exitCode, 0);
    assert.match(detachedRun.stdout, /cli_pkce_marker=1/u);
    assert.match(detachedRun.stderr, /Failed to read code/u);
    assert.equal(state.browserPageLoads, 0);

    // Step c. Real PTY drives manual PKCE login end to end against synthetic server.
    const expectEndpoint = `http://localhost:${String(state.port)}/__probe/expect`;
    const ptyRun = await runAsyncCommand(
      [
        "python3",
        "-c",
        PTY_LOGIN_PYTHON,
        expectEndpoint,
        SYNTHETIC_AUTH_CODE,
        ...devinArgv(devinCommand, ["auth", "login", "--force-manual-token-flow"]),
      ],
      env,
    );
    assert.equal(ptyRun.exitCode, 0, ptyRun.stderr);
    const ptySummary = asObject(JSON.parse(ptyRun.stdout));
    const ptyExitCode = typeof ptySummary?.exitCode === "number" ? ptySummary.exitCode : -1;
    const ptyOutput = typeof ptySummary?.output === "string" ? ptySummary.output : "";
    assert.equal(ptyExitCode, 0);
    assert.equal(ptySummary?.sentCode, true);
    assert.match(ptyOutput, /Login successful! Credentials stored\./u);
    assert.ok(state.expected !== null);
    assert.equal(state.expected.method, "S256");
    assert.equal(state.expected.marker, "1");
    assert.ok(state.expected.state.length > 0);
    assert.equal(state.pkceVerified, true);
    assert.equal(state.browserPageLoads, 0);

    // Step d. Authenticated devin auth status prints structured sections and parses cleanly.
    const authedStatusRun = await runAsyncCommand(devinArgv(devinCommand, ["auth", "status"]), env);
    assert.equal(authedStatusRun.exitCode, 0);
    assert.match(authedStatusRun.stdout, /^Logged in \(via Devin\)\./mu);
    assert.match(authedStatusRun.stdout, /^Credentials:/mu);
    assert.match(authedStatusRun.stdout, /^User:/mu);
    assert.match(authedStatusRun.stdout, /^\s*Email:\s+alice@example\.test$/mu);
    assert.match(authedStatusRun.stdout, /^Account:/mu);
    assert.match(authedStatusRun.stdout, /^\s*Plan:\s+Teams$/mu);
    assert.match(authedStatusRun.stdout, /^Team settings:/mu);
    assert.doesNotMatch(authedStatusRun.stdout, /^User \/ team info:/mu);
    const authedParsed = parseDevinAuthStatus(authedStatusRun.stdout);
    assert.deepEqual(authedParsed, {
      kind: "logged_in",
      source: "devin auth status",
      account: {
        method: "Devin",
        credential: "account",
        email: "alice@example.test",
        plan: "Teams",
      },
    });

    // Step e1. Second login while valid credentials.toml exists exits 0 with already logged in.
    const alreadyValidRun = await runAsyncCommand(
      devinArgv(devinCommand, ["auth", "login", "--force-manual-token-flow"]),
      env,
    );
    assert.equal(alreadyValidRun.exitCode, 0);
    assert.match(alreadyValidRun.stdout, /You are already logged in\./u);

    // Step e2. Login still exits 0 with already logged in when credentials.toml holds a 401-rejected key,
    // while devin auth status detects the 401 rejection and returns logged_out.
    const credsPath = path.join(home, ".local", "share", "devin", "credentials.toml");
    assert.equal(existsSync(credsPath), true);
    const originalCreds = readFileSync(credsPath, "utf8");
    writeFileSync(credsPath, originalCreds.replace(VALID_STORED_KEY, REJECTED_STORED_KEY), "utf8");

    const alreadyRejectedRun = await runAsyncCommand(
      devinArgv(devinCommand, ["auth", "login", "--force-manual-token-flow"]),
      env,
    );
    assert.equal(alreadyRejectedRun.exitCode, 0);
    assert.match(alreadyRejectedRun.stdout, /You are already logged in\./u);

    const rejectedStatusRun = await runAsyncCommand(devinArgv(devinCommand, ["auth", "status"]), env);
    assert.equal(rejectedStatusRun.exitCode, 0);
    assert.match(rejectedStatusRun.stdout, /^User \/ team info:/mu);
    assert.match(rejectedStatusRun.stdout, /Failed to fetch from server:/u);
    const rejectedParsed = parseDevinAuthStatus(rejectedStatusRun.stdout);
    assert.equal(rejectedParsed.kind, "logged_out");

    // Step f. Logout removes stored credentials and returns status to logged_out.
    const logoutRun = await runAsyncCommand(devinArgv(devinCommand, ["auth", "logout"]), env);
    assert.equal(logoutRun.exitCode, 0);
    assert.match(logoutRun.stdout, /Logged out successfully/u);
    assert.equal(existsSync(credsPath), false);

    const afterLogoutStatusRun = await runAsyncCommand(devinArgv(devinCommand, ["auth", "status"]), env);
    assert.equal(afterLogoutStatusRun.exitCode, 0);
    assert.equal(parseDevinAuthStatus(afterLogoutStatusRun.stdout).kind, "logged_out");
    assert.equal(state.browserPageLoads, 0);

    const summary = {
      platform: process.platform,
      version: versionRun.stdout.trim(),
      browserOpens: state.browserPageLoads,
      launcherIntercepts: countLauncherIntercepts(markerFile),
      checks: {
        initialLoggedOut: true,
        detachedNonTtyRejected: true,
        ptyManualPkceLogin: true,
        authenticatedStatusSections: true,
        parsedAuthStatus: authedParsed,
        alreadyLoggedInValidKeyExitZero: true,
        alreadyLoggedInRejectedKeyExitZero: true,
        rejectedKeyStatusLoggedOut: true,
        logoutAndLoggedOutAfter: true,
      },
      routes: {
        healthChecks: state.healthChecks,
        tokenExchanges: state.tokenExchanges,
        userStatusOk: state.userStatusOk,
        userStatusRejected: state.userStatusRejected,
        teamSettingsChecks: state.teamSettingsChecks,
      },
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await closeServer(server);
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
