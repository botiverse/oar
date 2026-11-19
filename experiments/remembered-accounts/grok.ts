/** Exercise native status, billing and logout using one synthetic Grok profile on Linux. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { grokAccountUsage } from "../../packages/oar/src/runtimes/grok/account-usage.js";
import { grokAuthStatus, grokLogout } from "../../packages/oar/src/runtimes/grok/auth.js";

const [command] = process.argv.slice(2);
assert.ok(command !== undefined && path.isAbsolute(command), "Pass the absolute path to grok");
const installation = { kind: "available", via: "executable", command } as const;
const home = await mkdtemp(path.join(tmpdir(), "oar-grok-account-"));
const grokHome = path.join(home, ".grok");
const issuer = "http://127.0.0.1:9";
const email = "previous@example.invalid";
const options = { timeoutMs: 10_000, env: {
  ...Object.fromEntries(Object.keys(process.env).map(key => [key, null])), PATH: process.env.PATH ?? "",
  HOME: home, USERPROFILE: home, GROK_HOME: grokHome, XDG_CONFIG_HOME: path.join(home, "config"),
  XDG_DATA_HOME: path.join(home, "data"), XDG_STATE_HOME: path.join(home, "state"), XDG_CACHE_HOME: path.join(home, "cache"),
  GROK_OAUTH2_ISSUER: issuer, GROK_OAUTH2_CLIENT_ID: "fixture", GROK_CLI_CHAT_PROXY_BASE_URL: issuer,
  GROK_XAI_API_BASE_URL: issuer, GROK_MODELS_BASE_URL: issuer, GROK_DISABLE_TELEMETRY: "1", BROWSER: "false",
  HTTP_PROXY: issuer, HTTPS_PROXY: issuer, ALL_PROXY: issuer, NO_PROXY: "localhost,127.0.0.1",
} };
async function seed(expiresInHours: number): Promise<void> {
  const hour = 3_600_000;
  const profile = { key: "never-issued", auth_mode: "oidc", create_time: new Date(Date.now() - 24 * hour),
    expires_at: new Date(Date.now() + expiresInHours * hour), oidc_issuer: issuer, oidc_client_id: "fixture",
    user_id: "fixture", email };
  await writeFile(path.join(grokHome, "auth.json"), JSON.stringify({ [`${issuer}::fixture`]: profile }), { mode: 0o600 });
}
try {
  await mkdir(grokHome);
  await seed(2);
  assert.deepEqual(await grokAuthStatus(installation, options), { kind: "logged_in", account: { method: "grok.com" }, source: "grok models" });
  await seed(-1);
  assert.deepEqual(await grokAuthStatus(installation, options), { kind: "logged_out", lastAccount: { email }, source: "grok models" });
  assert.deepEqual(await grokAccountUsage(installation, options), { kind: "reauth_required", reason: "not_authenticated", lastAccount: { email } });
  const logout = await grokLogout(installation, options);
  assert.equal(logout.kind, "logged_out");
  assert.deepEqual(await grokAuthStatus(installation, options), { kind: "logged_out", source: "grok models" });
  assert.deepEqual(await grokAccountUsage(installation, options), { kind: "reauth_required", reason: "not_authenticated" });
  console.log("Grok named the expired login on status and usage. Both omitted it after native logout.");
} finally { await rm(home, { recursive: true, force: true }); }
