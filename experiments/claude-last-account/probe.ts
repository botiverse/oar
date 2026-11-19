/** Linux. Pass an absolute Claude executable. All HTTP requests terminate at the local fixture. */
import assert from "node:assert/strict";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { claudeAuthStatus } from "../../packages/oar/src/runtimes/claude/auth-status.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { mockRefresh, REFRESH } from "../../sea-trial/vendor/support/user-configuration/claude-oauth.js";

const [command] = process.argv.slice(2);
assert.ok(command !== undefined && path.isAbsolute(command) && process.platform === "linux");
const root = await mkdtemp(path.join(tmpdir(), "oar-claude-last-account-"));
const profile = { accountUuid: "00000000-0000-4000-8000-000000000001", organizationUuid: "00000000-0000-4000-8000-000000000002",
  emailAddress: "browser-probe@example.invalid", displayName: "Local login probe" };

// oxlint-disable-next-line typescript/strict-void-return -- execFile also returns the child whose stdin receives the control requests.
const execute = promisify(execFile);

async function run(bin: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; input?: string }): Promise<{ code: number; stdout: string }> {
  const result = execute(bin, args, { cwd: options.cwd, env: options.env, timeout: 25_000, maxBuffer: 4 * 1024 * 1024 });
  result.child.stdin?.end(options.input);
  try {
    const { stdout } = await result;
    return { code: 0, stdout };
  } catch (error) {
    const info = asRecord(error);
    if (typeof info?.code === "number" && typeof info.stdout === "string") { return { code: info.code, stdout: info.stdout }; }
    // oxlint-disable-next-line eslint/preserve-caught-error -- Native output is private to each synthetic case.
    throw new Error("Local probe process did not finish");
  }
}

async function stored(home: string): Promise<JsonRecord | null> {
  const file = await readFile(path.join(home, ".claude.json"), "utf8").catch(() => "");
  return asRecord(asRecord(parseJson(file))?.oauthAccount);
}

function identity(source: JsonRecord | null): JsonRecord {
  return { hasEmail: source?.email === profile.emailAddress || source?.emailAddress === profile.emailAddress, hasName: source?.displayName === profile.displayName };
}

async function observe(bin: string, mode: "rejected" | "accepted" | "logout", tls: { key: Buffer; cert: Buffer }): Promise<void> {
  const home = path.join(root, mode);
  const customDir = mode === "accepted" ? undefined : path.join(home, "custom-config");
  const config = customDir ?? path.join(home, ".claude");
  await mkdir(config, { recursive: true });
  await writeFile(path.join(customDir ?? home, ".claude.json"), JSON.stringify({ oauthAccount: profile, hasCompletedOnboarding: true }));
  await writeFile(path.join(config, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-access", refreshToken: REFRESH,
    expiresAt: Date.now() + (mode === "logout" ? 3_600_000 : -60_000), scopes: ["user:profile", "user:inference", "user:sessions:claude_code"], subscriptionType: "pro" } }), { mode: 0o600 });
  const server = await mockRefresh(tls.key, tls.cert, mode === "rejected" ? "rejected" : "accepted");
  const env = { ...(customDir === undefined ? {} : { CLAUDE_CONFIG_DIR: customDir }), PATH: process.env.PATH ?? "", HOME: home, LANG: "C.UTF-8", HTTP_PROXY: server.url, HTTPS_PROXY: server.url, ALL_PROXY: server.url,
    NODE_EXTRA_CA_CERTS: path.join(root, "cert.pem"), DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  const status = async (): Promise<JsonRecord> => {
    const result = await run(bin, ["auth", "status", "--json"], { cwd: home, env });
    const body = asRecord(parseJson(result.stdout));
    assert.ok(typeof body?.loggedIn === "boolean");
    return { code: result.code, loggedIn: body.loggedIn, ...identity(body) };
  };
  try {
    if (mode === "logout") {
      const logout = await run(bin, ["auth", "logout"], { cwd: home, env });
      assert.equal(logout.code, 0);
    }
    const before = await status();
    const input = ["initialize", "get_usage"].map((subtype) => JSON.stringify({ type: "control_request", request_id: subtype,
      request: { subtype, ...(subtype === "get_usage" ? { skip_behaviors: true } : {}) } })).join("\n");
    const wire = await run(bin, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--safe-mode"], { cwd: home, env, input: `${input}\n` });
    const frames = wire.stdout.trim().split("\n").map((line) => asRecord(asRecord(parseJson(line))?.response));
    const init = frames.find((frame) => frame?.request_id === "initialize");
    const usage = frames.find((frame) => frame?.request_id === "get_usage");
    assert.ok(init?.subtype === "success" && usage !== undefined);
    const initialized = asRecord(asRecord(init.response)?.account);
    const after = await status();
    const retained = await stored(customDir ?? home);
    const overlay = { ...Object.fromEntries(Object.keys(process.env).map((name) => [name, null])), ...env };
    const projected = await claudeAuthStatus({ kind: "available", via: "executable", command: bin }, { env: overlay });
    assert.equal(server.seen.exchanges, mode === "logout" ? 0 : 1);
    assert.equal(after.loggedIn, mode === "accepted");
    assert.equal(after.hasEmail, mode === "accepted");
    assert.equal(identity(initialized).hasEmail, mode === "accepted");
    assert.equal(retained !== null, mode !== "logout");
    assert.equal(identity(retained).hasEmail, mode !== "logout");
    assert.equal(identity(retained).hasName, mode !== "logout");
    if (mode === "rejected") { assert.deepEqual(projected, { kind: "logged_out", source: "claude auth status --json", lastAccount: { email: profile.emailAddress, displayName: profile.displayName } }); }
    else if (mode === "logout") { assert.deepEqual(projected, { kind: "logged_out", source: "claude auth status --json" }); }
    else { assert.ok(projected.kind === "logged_in" && projected.account?.email === profile.emailAddress); }
    console.log(JSON.stringify({ mode, before, initialized: identity(initialized), usage: { subtype: usage?.subtype, available: asRecord(usage?.response)?.rate_limits_available },
      after, profile: { present: retained !== null, ...identity(retained) }, projected: projected.kind, remembered: projected.kind === "logged_out" && projected.lastAccount !== undefined, exchanges: server.seen.exchanges, routes: [...new Set(server.seen.routes)] }));
  } finally { await server.close(); }
}

try {
  const cert = path.join(root, "cert.pem"), key = path.join(root, "key.pem");
  const issued = await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=api.anthropic.com",
    "-addext", "subjectAltName=DNS:api.anthropic.com,DNS:platform.claude.com,DNS:console.anthropic.com,DNS:claude.ai,DNS:claude.com,DNS:api.claude.com",
    "-keyout", key, "-out", cert], { cwd: root, env: { PATH: process.env.PATH } });
  assert.equal(issued.code, 0);
  const tls = { key: await readFile(key), cert: await readFile(cert) };
  await Promise.all((["rejected", "accepted", "logout"] as const).map(async (mode) => { await observe(command, mode, tls); }));
} finally { await rm(root, { recursive: true, force: true }); }
