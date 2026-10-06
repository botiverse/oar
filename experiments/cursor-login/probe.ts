/**
 * The real `@cursor/sdk` login, driven through OAR's cursor `login` and
 * `authStatus`, against a local mock of the backend it talks to
 * (./mock-backend.ts). No account, no network, no real credentials: HOME
 * (and the XDG and Windows profile directories) point into a temporary
 * directory before the SDK loads, `CURSOR_API_KEY` is unset, and every
 * outbound TCP connection other than the mock's is refused and fails the
 * run. See README.md; run it on every `@cursor/sdk` upgrade.
 *
 * Run: pnpm tsx experiments/cursor-login/probe.ts [--keep]
 *
 * It pins what OAR's cursor login relies on: the SDK saves its key only
 * through the store it is given, after the mint (so the store OAR passes can
 * refuse a save once the login has ended), stops polling on its signal, and
 * prints nothing with `onLoginUrl` set. A cancel or deadline while the SDK
 * waits for the browser or while it mints its key must leave
 * `~/.cursor/sdk/auth.json` absent, or exactly as it was.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  AuthStatus,
  CursorRuntime,
  CursorSdk,
  LoginResult,
  ProviderLoginEvent,
  ProviderLoginInteraction,
} from "../../packages/oar/src/index.js";
import { ACCESS_TOKEN, MOCK_EMAIL, MOCK_KEY, startMockBackend } from "./mock-backend.js";

const DAY_MS = 24 * 60 * 60_000;
const PREVIOUS_KEY = "crsr_mock_previous_key_not_a_secret";
const PREVIOUS_EMAIL = "previous-login@example.invalid";
/** OAR's store refuses a save after the login ended with this message. */
const REFUSED = "the login ended before cursor stored its key; nothing was written";
/** How long after a stop the SDK must not poll again (its backoff starts at 1 s). */
const QUIET_MS = 2500;

const keep = process.argv.includes("--keep");
const root = mkdtempSync(path.join(os.tmpdir(), "oar-cursor-login-probe-"));

/** Every directory the SDK could resolve from the environment, inside `home`. */
function useHome(home: string): void {
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
  process.env.XDG_STATE_HOME = path.join(home, ".local", "state");
  process.env.XDG_CACHE_HOME = path.join(home, ".cache");
  process.env.APPDATA = path.join(home, "AppData", "Roaming");
  process.env.LOCALAPPDATA = path.join(home, "AppData", "Local");
  assert.equal(os.homedir(), home, "os.homedir() must follow the temporary HOME");
}

// Before anything loads the SDK: a temporary home, no key, no proxy, no browser.
for (const name of ["CURSOR_API_KEY", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NODE_USE_ENV_PROXY"]) {
  Reflect.deleteProperty(process.env, name);
}
process.env.NO_OPEN_BROWSER = "1";
useHome(path.join(root, "load"));

/** `host:port` (or `pipe:<path>`) that a `Socket.prototype.connect` call targets. */
function connectTarget(args: readonly unknown[]): string {
  // `net.connect` hands the socket its normalized arguments as one array.
  const [first, second]: readonly unknown[] = Array.isArray(args[0]) ? args[0] : args;
  const host = typeof second === "string" ? second : "localhost";
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/u.test(first))) {
    return `${host}:${String(first)}`;
  }
  if (typeof first === "string") {
    return `pipe:${first}`;
  }
  if (typeof first === "object" && first !== null) {
    if ("path" in first && typeof first.path === "string") {
      return `pipe:${first.path}`;
    }
    const port = "port" in first ? String(first.port) : "?";
    return `${"host" in first && typeof first.host === "string" ? first.host : "localhost"}:${port}`;
  }
  return "unknown target";
}

const violations: string[] = [];

/** Every outbound TCP connection (http, https, http2, fetch) goes through `Socket.prototype.connect`; only the mock's is let through. */
function guardNetwork(port: number): void {
  const allowed = new Set([`127.0.0.1:${String(port)}`, `localhost:${String(port)}`]);
  // oxlint-disable-next-line typescript/unbound-method -- called back with the socket as `this`.
  const original = net.Socket.prototype.connect;
  function guarded(this: net.Socket, ...args: unknown[]): net.Socket {
    const target = connectTarget(args);
    if (!allowed.has(target)) {
      violations.push(target);
      throw new Error(`cursor-login probe: refused a connection to ${target}; only the mock backend (127.0.0.1:${String(port)}) is reachable`);
    }
    const socket: unknown = Reflect.apply(original, this, args);
    assert.ok(socket instanceof net.Socket);
    return socket;
  }
  Object.defineProperty(net.Socket.prototype, "connect", { value: guarded, configurable: true, writable: true });
}

/** The guard refuses another host on every path the SDK could take (fetch, node:http, TLS); 127.0.0.2 is never contacted. */
async function guardRefuses(): Promise<string> {
  // A port fetch does not refuse on its own (it blocks 9 and other "bad ports" before connecting).
  const elsewhere = "127.0.0.2";
  const port = 59_999;
  const refusals = [
    await settled(fetch(`http://${elsewhere}:${String(port)}/`)),
    await settled((async (): Promise<void> => {
      await Promise.resolve();
      http.get(`http://${elsewhere}:${String(port)}/`).destroy();
    })()),
    await settled((async (): Promise<void> => {
      await Promise.resolve();
      net.connect({ host: elsewhere, port }).destroy();
    })()),
  ];
  const blocked = violations.splice(0);
  const target = `${elsewhere}:${String(port)}`;
  assert.deepEqual(blocked, [target, target, target], `the guard let a connection through: ${JSON.stringify(refusals)}`);
  assert.ok(refusals.every((refusal) => refusal !== "resolved"), JSON.stringify(refusals));
  return `fetch, node:http and net.connect to ${target} refused`;
}

const mock = await startMockBackend();
guardNetwork(mock.port);
process.env.CURSOR_BACKEND_URL = mock.url;
process.env.CURSOR_WEBSITE_URL = mock.url;

const { createCursorRuntime } = await import("../../packages/oar/src/index.js");
const real = await import("@cursor/sdk");
assert.equal(real.getDefaultSdkAuthPath(), path.join(root, "load", ".cursor", "sdk", "auth.json"));

async function settled(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
}

/** How the SDK's own `Cursor.auth.login` ended in the current run (OAR drops it, so the probe tees it). */
const tee: { sdkOutcome?: Promise<string> } = {};
const realAuth = real.Cursor.auth;
// The real SDK, with its login teed: OAR's exact options go to the real call, and its own promise goes back.
const sdk: CursorSdk = {
  Agent: real.Agent,
  Cursor: {
    models: real.Cursor.models,
    auth: {
      async login(options) {
        const login = realAuth.login(options);
        tee.sdkOutcome = settled(login);
        const result = await login;
        return result;
      },
      async status() {
        const status = await realAuth.status();
        return status;
      },
    },
  },
  FileCredentialStore: real.FileCredentialStore,
};
const runtime: CursorRuntime = createCursorRuntime({
  sdk: async () => {
    await Promise.resolve();
    return sdk;
  },
});
const bundled = { kind: "available", via: "bundled" } as const;

interface FileState {
  readonly exists: boolean;
  /** First 16 hex digits of the file's sha256; the contents are never printed. */
  readonly sha256?: string;
  readonly mtimeMs?: number;
  readonly mode?: string;
}

function fileState(file: string): FileState {
  if (!existsSync(file)) {
    return { exists: false };
  }
  const stat = statSync(file);
  return {
    exists: true,
    sha256: createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16),
    mtimeMs: stat.mtimeMs,
    mode: (stat.mode % 0o1000).toString(8),
  };
}

/** What the SDK wrote to stdout and stderr while `run` ran. */
async function capturedOutput<T>(run: () => Promise<T>): Promise<{ readonly value: T; readonly output: string }> {
  const written: string[] = [];
  const record = (chunk: unknown): boolean => {
    written.push(chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : String(chunk));
    return true;
  };
  const streams = [process.stdout, process.stderr];
  for (const stream of streams) {
    Object.defineProperty(stream, "write", { value: record, configurable: true, writable: true });
  }
  try {
    const value = await run();
    return { value, output: written.join("") };
  } finally {
    for (const stream of streams) {
      Reflect.deleteProperty(stream, "write");
    }
  }
}

/** The person opening the sign-in URL in a browser. */
async function openPage(url: string): Promise<string> {
  const page = await fetch(url);
  const text = await page.text();
  return text;
}

async function until(condition: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    // oxlint-disable-next-line no-await-in-loop -- polling one condition
    await sleep(20);
  }
}

interface Plan {
  /** The person opens the URL (the mock's page signs that uuid in). */
  readonly approve: boolean;
  /** The mock holds `CreateUserApiKey` until the login has settled. */
  readonly holdMint: boolean;
  /** Abort `interaction.signal` once the SDK polls, or once its mint request arrives. */
  readonly abort?: "polling" | "minting";
  readonly timeoutMs?: number;
}

interface LoginRun {
  readonly result: LoginResult;
  readonly events: readonly ProviderLoginEvent[];
  readonly prompts: number;
  /** How the SDK's own login ended. */
  readonly sdk: string;
  readonly mintBeforeResult: boolean;
  readonly pollsAtResult: number;
  /** `QUIET_MS` after the SDK settled. */
  readonly pollsLater: number;
  readonly output: string;
}

async function runLogin(plan: Plan): Promise<LoginRun> {
  mock.reset();
  delete tee.sdkOutcome;
  const hold = plan.holdMint ? mock.holdMint() : undefined;
  let mintArrived = false;
  const abort = new AbortController();
  const events: ProviderLoginEvent[] = [];
  const browser: Promise<string>[] = [];
  let prompts = 0;
  const interaction: ProviderLoginInteraction = {
    signal: abort.signal,
    onEvent(event) {
      events.push(event);
      if (event.kind === "auth_url" && plan.approve) {
        browser.push(openPage(event.url));
      }
    },
    async prompt() {
      prompts += 1;
      await Promise.resolve();
      throw new Error("cursor's login asks no prompt");
    },
  };
  const { value, output } = await capturedOutput(async () => {
    const login = runtime.login(bundled, interaction, plan.timeoutMs === undefined ? {} : { timeoutMs: plan.timeoutMs });
    const arrived = hold === undefined ? undefined : (async (): Promise<void> => {
      await hold.arrived;
      mintArrived = true;
    })();
    if (plan.abort === "polling") {
      await until(() => mock.seen.polls >= 1, "the SDK's first poll");
      abort.abort();
    }
    if (plan.abort === "minting") {
      assert.ok(arrived !== undefined, "an abort while minting needs a held mint");
      await arrived;
      abort.abort();
    }
    const result = await login;
    const mintBeforeResult = mintArrived;
    const pollsAtResult = mock.seen.polls;
    // The mint (if held) answers only now, after OAR has settled; the SDK then tries to save.
    hold?.release();
    assert.ok(tee.sdkOutcome !== undefined, "OAR never called Cursor.auth.login");
    const sdkEnded = await tee.sdkOutcome;
    await sleep(QUIET_MS);
    await Promise.all(browser);
    return { result, mintBeforeResult, pollsAtResult, sdk: sdkEnded, pollsLater: mock.seen.polls };
  });
  return { ...value, events, prompts, output };
}

interface Home {
  readonly home: string;
  readonly authFile: string;
  readonly before: FileState;
  readonly statusBefore: AuthStatus;
}

/** A fresh temporary home, empty or holding a previous login the SDK's own store wrote. */
async function scenarioHome(name: string, previous: boolean): Promise<Home> {
  const home = path.join(root, name);
  useHome(home);
  const authFile = path.join(home, ".cursor", "sdk", "auth.json");
  assert.equal(real.getDefaultSdkAuthPath(), authFile, "the SDK must resolve auth.json inside the temporary home");
  if (previous) {
    await new real.FileCredentialStore().save({
      version: 1,
      backendUrl: mock.url,
      apiKey: PREVIOUS_KEY,
      apiKeyExpiresAtMs: Date.now() + 30 * DAY_MS,
      email: PREVIOUS_EMAIL,
      createdAtMs: Date.now(),
    });
  }
  return { home, authFile, before: fileState(authFile), statusBefore: await runtime.authStatus(bundled) };
}

function leaks(value: unknown): boolean {
  const text = JSON.stringify(value);
  return [MOCK_KEY, PREVIOUS_KEY, ACCESS_TOKEN].some((secret) => text.includes(secret));
}

/** The URL the SDK built for the browser, relayed as the one event. */
function assertUrlOnly(run: LoginRun): void {
  assert.equal(run.prompts, 0, "cursor's login must not prompt");
  assert.equal(run.events.length, 1, `one event expected, got ${JSON.stringify(run.events.map((event) => event.kind))}`);
  const [event] = run.events;
  assert.ok(event?.kind === "auth_url" && event.url.startsWith(`${mock.url}/loginDeepControl?`) && event.url.includes("redirectTarget=sdk"));
  // With `onLoginUrl` set and `openBrowser: false` the SDK prints nothing: no URL, no fallback warning.
  assert.ok(!/loginDeepControl|Could not open a browser|warning:/u.test(run.output), `the SDK printed: ${JSON.stringify(run.output)}`);
  assert.equal(mock.seen.getPolls, 0, "the SDK fell back to GET /auth/poll");
  assert.deepEqual(mock.seen.unexpected, [], "the SDK called an endpoint the mock does not serve");
  assert.ok(!leaks(run), "a key or token reached an event or a result");
}

/** After a stop: auth.json as it was (absent in an empty home), the previous login still read back. */
async function assertUntouched(home: Home): Promise<string> {
  const after = fileState(home.authFile);
  assert.deepEqual(after, home.before, "auth.json changed after a stop");
  if (!home.before.exists) {
    assert.ok(!existsSync(path.join(home.home, ".cursor")), "the login created ~/.cursor after a stop");
  }
  const status = await runtime.authStatus(bundled);
  assert.deepEqual(status, home.statusBefore, "the stored login reads differently after a stop");
  return home.before.exists ? `auth.json unchanged (sha256 ${home.before.sha256 ?? ""}, mtime kept)` : "no auth.json, no ~/.cursor";
}

function assertQuiet(run: LoginRun): void {
  assert.equal(run.pollsLater, run.pollsAtResult, `the SDK kept polling after the stop (${String(run.pollsAtResult)} → ${String(run.pollsLater)})`);
}

async function success(): Promise<string> {
  const home = await scenarioHome("success", false);
  assert.equal(home.statusBefore.kind, "logged_out");
  const started = Date.now();
  const run = await runLogin({ approve: true, holdMint: false });
  assertUrlOnly(run);
  const { result } = run;
  assert.ok(result.kind === "logged_in", `logged_in expected: ${JSON.stringify(result)}`);
  assert.equal(result.account?.email, MOCK_EMAIL);
  const expiresMs = Date.parse(result.account.expiresAt ?? "");
  assert.ok(Math.abs(expiresMs - (started + 90 * DAY_MS)) < 10 * 60_000, `expiresAt ${String(result.account.expiresAt)} is not about 90 days out`);
  assert.equal(run.sdk, "resolved");
  // The SDK's file: written once, owner-only, the minted key against the mock.
  const after = fileState(home.authFile);
  assert.ok(after.exists, "a successful login must write auth.json");
  if (process.platform !== "win32") {
    assert.equal(after.mode, "600");
  }
  const stored: unknown = JSON.parse(readFileSync(home.authFile, "utf8"));
  assert.ok(typeof stored === "object" && stored !== null);
  assert.deepEqual(
    Object.fromEntries(Object.entries(stored).filter(([key]) => key !== "createdAtMs").map(([key, value]) => [key, key === "apiKey" ? value === MOCK_KEY : value])),
    { version: 1, backendUrl: mock.url, apiKey: true, apiKeyExpiresAtMs: expiresMs, email: MOCK_EMAIL },
  );
  const status = await runtime.authStatus(bundled);
  assert.deepEqual(status, { kind: "logged_in", account: result.account, source: "Cursor.auth.status" });
  assert.ok(!leaks(status));
  // The backend saw the PKCE poll, one mint with the session token, then GetMe.
  const [mint] = mock.seen.mints;
  assert.ok(mock.seen.pkceVerified && mock.seen.mints.length === 1 && mint?.bearer === true && mock.seen.getMes === 1, JSON.stringify(mock.seen));
  assert.equal(mint.expiresAtMs, expiresMs);
  assert.match(mint.name, /^Cursor SDK login \(.+\)$/u);
  return `logged_in as ${MOCK_EMAIL} (expires ${result.account.expiresAt ?? ""}); auth.json written (sha256 ${after.sha256 ?? ""}, mode ${after.mode ?? ""}); `
    + `status logged_in, same account; mock: ${String(run.pollsAtResult)} polls, PKCE verified, 1 mint ("${mint.name}"), 1 GetMe; SDK resolved; printed ${String(run.output.length)} bytes`;
}

async function cancelWhilePolling(previous: boolean): Promise<string> {
  const home = await scenarioHome(`cancel-polling-${previous ? "previous" : "fresh"}`, previous);
  const run = await runLogin({ approve: false, holdMint: false, abort: "polling" });
  assertUrlOnly(run);
  assert.deepEqual(run.result, { kind: "cancelled" });
  assert.ok(run.sdk.includes("Login was cancelled."), `the SDK ended: ${run.sdk}`);
  assert.equal(mock.seen.mints.length, 0);
  const untouched = await assertUntouched(home);
  assertQuiet(run);
  return `cancelled; ${untouched}; SDK stopped polling after ${String(run.pollsAtResult)} poll(s) ("${run.sdk}")`;
}

async function cancelWhileMinting(previous: boolean): Promise<string> {
  const home = await scenarioHome(`cancel-minting-${previous ? "previous" : "fresh"}`, previous);
  const run = await runLogin({ approve: true, holdMint: true, abort: "minting" });
  assertUrlOnly(run);
  assert.deepEqual(run.result, { kind: "cancelled" });
  assert.ok(run.mintBeforeResult, "the cancel must land while the mint is held");
  const untouched = await assertUntouched(home);
  // Released after the cancel, the SDK finished minting, asked GetMe and tried to save: refused.
  assert.equal(mock.seen.getMes, 1, "the SDK did not go on after the held mint");
  assert.ok(run.sdk.includes(REFUSED), `the SDK's late save must be refused; it ended: ${run.sdk}`);
  return `cancelled while CreateUserApiKey was held; ${untouched}; the SDK went on to GetMe and its save was refused ("${run.sdk}")`;
}

async function timeoutWhilePolling(previous: boolean): Promise<string> {
  const home = await scenarioHome(`timeout-polling-${previous ? "previous" : "fresh"}`, previous);
  const run = await runLogin({ approve: false, holdMint: false, timeoutMs: 2500 });
  assertUrlOnly(run);
  assert.deepEqual(run.result, { kind: "failed", reason: "timed_out", detail: "no sign-in within 2500 ms" });
  const untouched = await assertUntouched(home);
  assert.ok(run.sdk.includes("Login was cancelled."), `the SDK ended: ${run.sdk}`);
  assertQuiet(run);
  return `timed_out; ${untouched}; SDK stopped polling after ${String(run.pollsAtResult)} poll(s)`;
}

async function timeoutWhileMinting(previous: boolean): Promise<string> {
  const home = await scenarioHome(`timeout-minting-${previous ? "previous" : "fresh"}`, previous);
  const run = await runLogin({ approve: true, holdMint: true, timeoutMs: 4000 });
  assertUrlOnly(run);
  assert.deepEqual(run.result, { kind: "failed", reason: "timed_out", detail: "no sign-in within 4000 ms" });
  assert.ok(run.mintBeforeResult, "the deadline must pass while the mint is held");
  const untouched = await assertUntouched(home);
  assert.equal(mock.seen.getMes, 1, "the SDK did not go on after the held mint");
  assert.ok(run.sdk.includes(REFUSED), `the SDK's late save must be refused; it ended: ${run.sdk}`);
  return `timed_out while CreateUserApiKey was held; ${untouched}; the SDK's late save was refused`;
}

/** Name, scenario, and whether its home starts with a previous login. */
const scenarios: readonly (readonly [string, (previous: boolean) => Promise<string>, boolean])[] = [
  ["success", success, false],
  ["cancel while polling, empty home", cancelWhilePolling, false],
  ["cancel while polling, previous login", cancelWhilePolling, true],
  ["cancel while minting, empty home", cancelWhileMinting, false],
  ["cancel while minting, previous login", cancelWhileMinting, true],
  ["timeout while polling, empty home", timeoutWhilePolling, false],
  ["timeout while polling, previous login", timeoutWhilePolling, true],
  ["timeout while minting, empty home", timeoutWhileMinting, false],
  ["timeout while minting, previous login", timeoutWhileMinting, true],
];

const sdkVersion: unknown = JSON.parse(readFileSync(new URL("../../node_modules/@cursor/sdk/package.json", import.meta.url), "utf8"));
assert.ok(typeof sdkVersion === "object" && sdkVersion !== null && "version" in sdkVersion && typeof sdkVersion.version === "string");
process.stdout.write(`@cursor/sdk ${sdkVersion.version}, mock backend ${mock.url}, temporary homes under ${root}\n`);
const watchdog = setTimeout(() => {
  process.stderr.write("cursor-login probe: no end after 180 s\n");
  process.exit(1);
}, 180_000);
watchdog.unref();

let failed = 0;
try {
  process.stdout.write(`PASS  network guard: ${await guardRefuses()}\n`);
} catch (error) {
  failed += 1;
  process.stdout.write(`FAIL  network guard: ${error instanceof Error ? error.message : String(error)}\n`);
}
for (const [name, scenario, previous] of scenarios) {
  try {
    // oxlint-disable-next-line no-await-in-loop -- one HOME at a time: the scenarios share the process environment.
    const detail = await scenario(previous);
    process.stdout.write(`PASS  ${name}: ${detail}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
if (violations.length > 0) {
  failed += 1;
  process.stdout.write(`FAIL  network guard: the run tried to reach ${[...new Set(violations)].join(", ")}\n`);
}
process.stdout.write(`${String(scenarios.length - Math.min(failed, scenarios.length))}/${String(scenarios.length)} scenarios passed${violations.length > 0 ? ", network guard tripped" : ", no connection but the mock's"}\n`);

await mock.close();
if (keep) {
  process.stdout.write(`kept ${root}\n`);
} else {
  rmSync(root, { recursive: true, force: true });
}
// The SDK may keep sockets or timers alive; the probe is done.
process.exit(failed === 0 ? 0 : 1);
