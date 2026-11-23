/* oxlint-disable import/max-dependencies -- Recorded account replies, child environment, and fixture ownership share one native peer. */
import guardedFixtureArgs from "../fixtures/guard-processes.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { antigravityAccountUsage, projectAntigravityUsage } from "../../packages/oar/src/runtimes/antigravity/account-usage.js";
import { antigravityAuthStatus } from "../../packages/oar/src/runtimes/antigravity/auth.js";
import {
  antigravitySilentAuthEnv,
  clearAntigravityPlanCache,
  projectAntigravityTier,
  readAntigravityPlan,
} from "../../packages/oar/src/runtimes/antigravity/account.js";
import {
  isPlainTokenFileAuthoritative,
  projectAntigravityTokenEmail,
  readAntigravityTokenEmail,
} from "../../packages/oar/src/runtimes/antigravity/token-email.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { holdFixtureDeadline } from "../fixtures/fixture-deadline.js";
import { eventually, fakeAgentBinary, gone, reportedProcess } from "../fixtures/process-tree.js";

// Recorded agy 1.5.13 ACP initialize and authenticate replies (2026-11-20), identifiers removed.
const authFixtureText = readFileSync(path.join(import.meta.dirname, "agy-1.5.13-authenticate.json"), "utf8");
const recordedAuth = asRecord(parseJson(authFixtureText)) ?? {};
const usageFixtureText = readFileSync(path.join(import.meta.dirname, "agy-1.5.7-usage.json"), "utf8");
const recordedUsage: unknown = parseJson(usageFixtureText);

const dirs: string[] = [];
afterEach(() => {
  clearAntigravityPlanCache();
  for (const dir of dirs.splice(0)) { rmSync(dir, { recursive: true, force: true }); }
});

interface FakeAccountOptions {
  readonly persistedMethod?: string;
  readonly tokenJson?: unknown;
  readonly advertiseTier?: boolean;
  readonly authMode?: "ok" | "no_browser" | "stall";
  readonly loggedIn?: boolean;
}

function writeFakeState(dir: string, options: FakeAccountOptions): void {
  const cliDir = path.join(dir, ".gemini", "antigravity-cli");
  if (options.persistedMethod !== undefined) {
    const cacheDir = path.join(cliDir, "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(path.join(cacheDir, "acp-auth-state.json"), JSON.stringify({ methodId: options.persistedMethod }));
  }
  if (options.tokenJson !== undefined) {
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(path.join(cliDir, "antigravity-oauth-token"), JSON.stringify(options.tokenJson), { mode: 0o600 });
  }
}

function fakeAgyScript(config: Record<string, unknown>): string {
  return [
    `import { writeProcessReport } from ${JSON.stringify(new URL("../fixtures/process-tree.ts", import.meta.url).href)};`,
    'import { appendFileSync } from "node:fs";',
    'import { createInterface } from "node:readline";',
    `const cfg = ${JSON.stringify(config)};`,
    String.raw`const log = (entry) => appendFileSync(cfg.traceFile, JSON.stringify(entry) + "\n");`,
    'const args = process.argv.slice(2);',
    'log({ kind: "call", args, ssh: process.env.SSH_CONNECTION ?? null, display: process.env.DISPLAY ?? null, wayland: process.env.WAYLAND_DISPLAY ?? null });',
    'if (args[0] === "models") { if (!cfg.loggedIn) { console.error("Please sign in to view available models"); process.exit(1); } console.log("gemini-3.8-flash"); process.exit(0); }',
    'if (args[0] === "-p" && args[1] === "/usage") { process.stdout.write(JSON.stringify(cfg.usageReply)); process.exit(0); }',
    'if (args[0] === "acp") {',
    '  createInterface({ input: process.stdin }).on("line", (line) => {',
    '    const req = JSON.parse(line);',
    '    log({ kind: "rpc", method: req.method, params: req.params });',
    String.raw`    if (req.method === "initialize") { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: cfg.initReply }) + "\n"); return; }`,
    '    if (req.method === "authenticate") {',
    '      if (cfg.authMode === "stall") { writeProcessReport(cfg.pidFile, process.pid); setInterval(() => {}, 1000); return; }',
    String.raw`      if (cfg.authMode === "no_browser") { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32603, message: "No browser is available here (this is a remote (SSH) session)." } }) + "\n"); return; }`,
    String.raw`      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: cfg.authReply }) + "\n");`,
    '    }',
    '  });',
    '}',
  ].join("\n");
}

function readTrace(traceFile: string): readonly JsonRecord[] {
  if (!existsSync(traceFile)) { return []; }
  return readFileSync(traceFile, "utf8").trim().split("\n").map((line) => asRecord(parseJson(line)) ?? {});
}

function fakeAccountAgy(options: FakeAccountOptions = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-agy-plan-"));
  dirs.push(dir);
  writeFakeState(dir, options);
  const traceFile = path.join(dir, "trace.jsonl");
  const pidFile = path.join(dir, "acp.pid");
  const script = path.join(dir, "fake-agy.mjs");
  const initReply = options.advertiseTier === false
    ? { ...asRecord(recordedAuth.initialize), agentCapabilities: { auth: { logout: {} } } }
    : recordedAuth.initialize;
  writeFileSync(script, fakeAgyScript({
    traceFile, pidFile, initReply, authReply: recordedAuth.authenticate,
    usageReply: recordedUsage, authMode: options.authMode ?? "ok", loggedIn: options.loggedIn ?? true,
  }));
  const env = { HOME: dir, USERPROFILE: dir, DISPLAY: ":99", WAYLAND_DISPLAY: "wayland-0", DBUS_SESSION_BUS_ADDRESS: null, XDG_RUNTIME_DIR: dir };
  return {
    installation: { kind: "available", via: "executable", command: fakeAgentBinary(dir, guardedFixtureArgs(script)), version: "1.5.13" } as const,
    env, dir, ready: () => existsSync(pidFile), trace: () => readTrace(traceFile), acpPid: () => reportedProcess(JSON.parse(readFileSync(pidFile, "utf8"))),
  };
}

function encodeBase64Url(part: unknown): string {
  return Buffer.from(JSON.stringify(part), "utf8").toString("base64url");
}

function fakeJwt(payload: Record<string, unknown>): string {
  return `${encodeBase64Url({ alg: "none", typ: "JWT" })}.${encodeBase64Url(payload)}.synthetic`;
}

async function reachableSecretService(): Promise<boolean> {
  await Promise.resolve();
  return true;
}

async function unreachableSecretService(): Promise<boolean> {
  await Promise.resolve();
  return false;
}

test("projectAntigravityTier and projectAntigravityTokenEmail read recorded shapes and omit missing values", () => {
  expect(projectAntigravityTier(recordedAuth.authenticate)).toBe("Google AI Ultra");
  expect(projectAntigravityTier({ _meta: { antigravity: { tier: { name: "   " } } } })).toBeUndefined();
  expect(projectAntigravityTokenEmail({ id_token_email: "alice@example.com", token: { access_token: "synthetic-secret" } })).toBe("alice@example.com");
  expect(projectAntigravityTokenEmail({ id_token: fakeJwt({ email: "bob@example.com" }) })).toBe("bob@example.com");
  expect(projectAntigravityTokenEmail({ token: { access_token: "synthetic-secret" } })).toBeUndefined();
  expect(projectAntigravityUsage(recordedUsage, undefined, { email: "alice@example.com", plan: "Google AI Ultra" })).toMatchObject({
    kind: "available", email: "alice@example.com", plan: "Google AI Ultra",
  });
});

test("isPlainTokenFileAuthoritative allows only Linux when Secret Service is unreachable", async () => {
  const env = { HOME: tmpdir() };
  expect(await isPlainTokenFileAuthoritative(env, { platform: "darwin" })).toBe(false);
  expect(await isPlainTokenFileAuthoritative(env, { platform: "win32" })).toBe(false);
  expect(await isPlainTokenFileAuthoritative(env, { platform: "linux", secretServiceReachable: reachableSecretService })).toBe(false);
  expect(await isPlainTokenFileAuthoritative(env, { platform: "linux", secretServiceReachable: unreachableSecretService })).toBe(true);
});

test("readAntigravityTokenEmail omits stale plain-file emails whenever a keyring backend could shadow them", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-agy-keyring-"));
  dirs.push(dir);
  writeFakeState(dir, { tokenJson: { id_token_email: "stale@example.com" } });
  const env = { HOME: dir, USERPROFILE: dir };
  expect(await readAntigravityTokenEmail(env, { platform: "darwin" })).toBeUndefined();
  expect(await readAntigravityTokenEmail(env, { platform: "win32" })).toBeUndefined();
  expect(await readAntigravityTokenEmail(env, { platform: "linux", secretServiceReachable: reachableSecretService })).toBeUndefined();
  expect(await readAntigravityTokenEmail(env, { platform: "linux", secretServiceReachable: unreachableSecretService })).toBe("stale@example.com");
});

test("antigravitySilentAuthEnv sets SSH_CONNECTION backstop and clears display variables", () => {
  const env = antigravitySilentAuthEnv({ PATH: "/usr/bin", DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" });
  expect(env.SSH_CONNECTION).toBe("1");
  expect(env.DISPLAY).toBeUndefined();
  expect(env.WAYLAND_DISPLAY).toBeUndefined();
  expect(antigravitySilentAuthEnv({ SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 5000" }).SSH_CONNECTION).toBe("10.0.0.1 22 10.0.0.2 5000");
});

test("authStatus populates plan (and email on headless Linux) via one persisted ACP method without opening a session", async () => {
  const fake = fakeAccountAgy({ persistedMethod: "oauth-personal", tokenJson: { auth_method: "consumer", id_token_email: "alice@example.com", token: { access_token: "synthetic-do-not-leak" } } });
  const status = await antigravityAuthStatus(fake.installation, { env: fake.env });
  const expectedAccount = process.platform === "linux" ? { email: "alice@example.com", plan: "Google AI Ultra" } : { plan: "Google AI Ultra" };
  expect(status).toEqual({ kind: "logged_in", account: expectedAccount, source: "agy models" });
  expect(JSON.stringify(status)).not.toContain("synthetic-do-not-leak");
  const authTrace = fake.trace();
  expect(authTrace.find((entry) => entry.kind === "call" && Array.isArray(entry.args) && entry.args[0] === "acp")).toMatchObject({ args: ["acp"], ssh: "1", display: null, wayland: null });
  expect(authTrace.filter((entry) => entry.kind === "rpc" && entry.method === "authenticate")).toEqual([{ kind: "rpc", method: "authenticate", params: { methodId: "oauth-personal" } }]);
  expect(authTrace.some((entry) => entry.kind === "rpc" && entry.method === "session/new")).toBe(false);
});

test("accountUsage reuses authStatus's single ACP tier probe and caches positive plan reads", async () => {
  const fake = fakeAccountAgy({ persistedMethod: "oauth-personal", tokenJson: { id_token_email: "alice@example.com", token: { access_token: "synthetic-do-not-leak" } } });
  const usage = await antigravityAccountUsage(fake.installation, { env: fake.env });
  expect(usage).toMatchObject({ kind: "available", plan: "Google AI Ultra", rateLimited: false, ...(process.platform === "linux" ? { email: "alice@example.com" } : {}) });
  expect(JSON.stringify(usage)).not.toContain("synthetic-do-not-leak");
  await antigravityAuthStatus(fake.installation, { env: fake.env });
  expect(fake.trace().filter((entry) => entry.kind === "call").map((entry) => entry.args)).toEqual([["models"], ["acp"], ["-p", "/usage", "--output-format", "json"], ["models"]]);
});

test("signed out reports lastAccount only when plain token file is authoritative, without spawning agy acp", async () => {
  const signedOut = fakeAccountAgy({ persistedMethod: "oauth-personal", loggedIn: false, tokenJson: { id_token_email: "alice@example.com" } });
  const expectedLast = process.platform === "linux" ? { lastAccount: { email: "alice@example.com" } } : {};
  expect(await antigravityAuthStatus(signedOut.installation, { env: signedOut.env })).toEqual({ kind: "logged_out", source: "agy models", ...expectedLast });
  expect(await antigravityAccountUsage(signedOut.installation, { env: signedOut.env })).toEqual({ kind: "reauth_required", reason: "not_authenticated", ...expectedLast });
  expect(signedOut.trace().filter((entry) => entry.kind === "call").map((entry) => entry.args)).toEqual([["models"], ["models"]]);
});

test("omits plan without spawning agy acp when persisted method is missing or non-OAuth, and omits email when token file is absent", async () => {
  const noState = fakeAccountAgy();
  expect(await antigravityAuthStatus(noState.installation, { env: noState.env })).toEqual({ kind: "logged_in", source: "agy models" });
  expect(noState.trace().filter((entry) => entry.kind === "call").map((entry) => entry.args)).toEqual([["models"]]);

  const apiKey = fakeAccountAgy({ persistedMethod: "gemini-api-key" });
  expect(await antigravityAuthStatus(apiKey.installation, { env: apiKey.env })).toEqual({ kind: "logged_in", source: "agy models" });
  expect(apiKey.trace().filter((entry) => entry.kind === "call").map((entry) => entry.args)).toEqual([["models"]]);
});

test("omits plan when initialize does not advertise tier or authenticate refuses browser launch", async () => {
  const noCap = fakeAccountAgy({ persistedMethod: "oauth-personal", advertiseTier: false });
  expect(await antigravityAuthStatus(noCap.installation, { env: noCap.env })).toEqual({ kind: "logged_in", source: "agy models" });
  expect(noCap.trace().some((entry) => entry.kind === "rpc" && entry.method === "authenticate")).toBe(false);

  const refused = fakeAccountAgy({ persistedMethod: "oauth-personal", authMode: "no_browser" });
  expect(await antigravityAuthStatus(refused.installation, { env: refused.env })).toEqual({ kind: "logged_in", source: "agy models" });
});

test("kills a stalled ACP tier probe at its short deadline and omits plan", async () => {
  const stalled = fakeAccountAgy({ persistedMethod: "oauth-personal", authMode: "stall" });
  const startClock = holdFixtureDeadline();
  const plan = readAntigravityPlan(stalled.installation.command, { HOME: stalled.dir, USERPROFILE: stalled.dir }, { timeoutMs: 400 });
  const ready = await eventually(stalled.ready, 10_000);
  const started = performance.now();
  startClock();
  expect(await plan).toBeUndefined();
  expect(ready, "authenticate published its process identity").toBe(true);
  expect(performance.now() - started).toBeLessThan(2000);
  expect(await gone(stalled.acpPid())).toBe(true);
});
