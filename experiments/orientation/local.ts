/**
 * pnpm run build && pnpm tsx experiments/orientation/local.ts
 * Set OAR_CLAUDE_BIN and OAR_CODEX_BIN to the real binaries. Runs the built CLI
 * with synthetic stores and a proxy that rejects every connection. No account
 * is inherited, no model request is sent, and only public observations print.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runExecutable } from "../../packages/oar/src/shared/executable/index.js";
import { asRecord, asRecordList, parseJson } from "../../packages/oar/src/shared/json.js";

const temporary = await mkdtemp(path.join(tmpdir(), "oar-orient-local-"));
const home = await realpath(temporary);
const marker = path.join(home, "key-command-ran");
const claudeDir = path.join(home, ".claude"), codexDir = path.join(home, ".codex"), piDir = path.join(home, ".pi", "agent");
const apiHelper = `"${process.execPath.replaceAll("\\", "/")}" -e "require('node:fs').writeFileSync(Buffer.from('${Buffer.from(marker).toString("base64")}','base64').toString(),'ran');console.log('synthetic-key')"`;
const attempts: string[] = [];
const proxy = createServer((request, response) => { attempts.push(`${request.method ?? "GET"} ${new URL(request.url ?? "/", "http://localhost").pathname}`); response.writeHead(503); response.end(); });
proxy.on("connect", (request, socket) => { attempts.push(`CONNECT ${request.url ?? "unknown"}`); socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n"); });
const listening = Promise.withResolvers<void>();
proxy.once("error", listening.reject);
proxy.listen(0, "127.0.0.1", listening.resolve);
await listening.promise;
const address = proxy.address();
assert.ok(address !== null && typeof address !== "string");
const proxyUrl = `http://127.0.0.1:${String(address.port)}`;
const env: NodeJS.ProcessEnv = {};
for (const key of ["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TMP", "TEMP", "TMPDIR", "OAR_CLAUDE_BIN", "OAR_CODEX_BIN", "OAR_QODER_BIN"]) {
  if (process.env[key] !== undefined) { env[key] = process.env[key]; }
}
Object.assign(env, {
  HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir, OAR_PI_AGENT_DIR: piDir,
  HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl, NO_PROXY: "",
  DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
});

async function query(label: string, id: string, depth: "local" | "account" = "local"): Promise<void> {
  attempts.length = 0;
  const result = await runExecutable(process.execPath, [fileURLToPath(new URL("../../packages/cli/dist/index.js", import.meta.url)), "orient", id, "--json", "--depth", depth], { cwd: home, env, timeoutMs: 60_000 });
  assert.ok(result.ok, "built oar orient must finish successfully");
  const snapshot = asRecord(parseJson(result.stdout));
  assert.equal(snapshot?.depth, depth);
  const runtimes = asRecordList(snapshot.runtimes);
  assert.equal(runtimes.length, 1);
  for (const runtime of runtimes) { assert.equal(asRecord(asRecord(runtime.installation)?.value)?.kind, "available"); }
  console.log(JSON.stringify({ label, attempts, keyCommandRan: existsSync(marker), runtimes: runtimes.map(({ id: runtimeId, auth, providers }) => ({ id: runtimeId, auth, providers })) }));
  if (id === "codex" && depth === "local") { assert.deepEqual(runtimes[0]?.auth, { kind: "skipped", because: "depth" }); }
  if (depth === "local") {
    assert.equal(attempts.length, 0, "local may not contact the network");
    assert.equal(existsSync(marker), false, "local may not execute key commands");
  }
  assert.ok(!result.stdout.includes("synthetic-key") && !result.stdout.includes("synthetic-refresh"), "no synthetic secret may reach the public snapshot");
}

try {
  await Promise.all([claudeDir, codexDir, piDir].map(async (directory) => { await mkdir(directory, { recursive: true }); }));
  await writeFile(path.join(claudeDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-expired", refreshToken: "synthetic-refresh", expiresAt: 1, scopes: ["user:profile", "user:inference"], subscriptionType: "pro" } }));
  await writeFile(path.join(codexDir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "synthetic-key" }));
  const piCredentials = JSON.stringify({ anthropic: { type: "oauth", access: "synthetic-expired", refresh: "synthetic-refresh", expires: 1 }, deepseek: { type: "api_key", key: `!${apiHelper}` } });
  await writeFile(path.join(piDir, "auth.json"), piCredentials);
  await query("Codex stored API key", "codex");
  await rm(path.join(codexDir, "auth.json"));
  // Native classification uses the at- prefix; other strings take the JWT path.
  env.CODEX_ACCESS_TOKEN = "at-synthetic-personal-access-token";
  env.CODEX_AUTHAPI_BASE_URL = proxyUrl;
  await query("Codex personal access token is skipped locally", "codex");
  assert.ok(env.OAR_CODEX_BIN !== undefined && env.OAR_CODEX_BIN !== "", "set OAR_CODEX_BIN for the native control");
  const codexStatus = await runExecutable(env.OAR_CODEX_BIN, ["login", "status"], { cwd: home, env, timeoutMs: 20_000 });
  assert.equal(codexStatus.ok, false, "the local endpoint refuses token hydration");
  assert.ok(attempts.some((attempt) => attempt.includes("/v1/user-auth-credential/whoami")), "native Codex status hydrates personal access tokens over HTTP");
  console.log(JSON.stringify({ label: "Codex native personal-access-token status control", attempts }));
  delete env.CODEX_ACCESS_TOKEN;
  delete env.CODEX_AUTHAPI_BASE_URL;
  await query("Pi expired OAuth and stored key command", "pi");
  await query("Claude expired OAuth is skipped locally", "claude");
  await query("Claude expired OAuth account-depth control", "claude", "account");
  assert.ok(attempts.length > 0, "the network recorder must observe native Claude refresh attempts");
  assert.equal(await readFile(path.join(piDir, "auth.json"), "utf8"), piCredentials);
  await rm(path.join(claudeDir, ".credentials.json"));
  await writeFile(path.join(claudeDir, "settings.json"), JSON.stringify({ apiKeyHelper: apiHelper }));
  await query("Claude apiKeyHelper is skipped locally", "claude");
  assert.ok(env.OAR_CLAUDE_BIN !== undefined && env.OAR_CLAUDE_BIN !== "", "set OAR_CLAUDE_BIN for the native control");
  const status = await runExecutable(env.OAR_CLAUDE_BIN, ["auth", "status", "--json"], { cwd: home, env, timeoutMs: 20_000 });
  assert.ok(status.ok);
  console.log(JSON.stringify({ label: "Claude auth-status-only helper control", keyCommandRan: existsSync(marker), attempts }));
  assert.equal(existsSync(marker), false, "native auth status alone does not execute this apiKeyHelper");
  await query("Claude account-depth helper control", "claude", "account");
  assert.equal(existsSync(marker), true, "the explicit account-usage query resolves the configured helper");
  await rm(marker);
  if (env.OAR_QODER_BIN !== undefined) { await query("Qoder unproven auth reader is skipped locally", "qoder"); }
} finally {
  proxy.closeAllConnections();
  const closed = Promise.withResolvers<void>();
  proxy.close(() => { closed.resolve(); });
  await closed.promise;
  await rm(home, { recursive: true, force: true });
}
