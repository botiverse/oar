import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runExecutable } from "../../../../packages/oar/src/shared/executable/index.js";
import { serveMcpTools, type McpServer } from "../../../../packages/oar/src/index.js";
import { writeClaudeConfiguration } from "./claude-files.js";
import { configurationModel, ORIGINAL } from "./model.js";
import { mockRefresh, REFRESH, ROTATED, TOKEN } from "./claude-oauth.js";
import { claudeCredentialStore } from "./claude-store.js";

/** Only local mocks are reachable through this child's proxy; no host credentials are inherited. */
function cleanEnvironment(home: string, modelUrl: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TMP", "TEMP", "TMPDIR"]) {
    if (process.env[key] !== undefined) { env[key] = process.env[key]; }
  }
  return {
    ...env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    XDG_CONFIG_HOME: path.join(home, ".config"), ANTHROPIC_BASE_URL: modelUrl,
    ANTHROPIC_API_KEY: "fixture-only-not-a-secret", HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9", NO_PROXY: "localhost,127.0.0.1",
    DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0",
  };
}

function tool(name: string): { name: string; description: string; inputSchema: { type: "object"; properties: object }; handler: () => { content: { type: "text"; text: string }[] } } {
  return { name, description: name, inputSchema: { type: "object", properties: {} }, handler: () => ({ content: [{ type: "text", text: "ok" }] }) };
}

async function checkedRun(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const result = await runExecutable(command, args, { cwd, env, timeoutMs: 20_000 });
  assert.ok(result.ok, result.stderr);
  return result.stdout;
}

async function refreshServer(home: string, env: NodeJS.ProcessEnv): Promise<Awaited<ReturnType<typeof mockRefresh>>> {
  const cert = path.join(home, "cert.pem");
  const key = path.join(home, "key.pem");
  const config = path.join(home, "openssl.cnf");
  await writeFile(config, "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=OAR local configuration probe\n[ext]\nbasicConstraints=critical,CA:TRUE\nsubjectAltName=DNS:api.anthropic.com,DNS:platform.claude.com,DNS:console.anthropic.com,DNS:claude.ai,DNS:claude.com,DNS:api.claude.com\n");
  await checkedRun("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", config, "-keyout", key, "-out", cert], home, env);
  return mockRefresh(await readFile(key), await readFile(cert));
}

export interface ClaudeConfigurationFixture {
  readonly home: string;
  readonly cwd: string;
  readonly credentials: string;
  readonly credentialStorage: "file" | "keychain";
  readonly debugFile: string;
  readonly model: Awaited<ReturnType<typeof configurationModel>>;
  readonly oauth: Awaited<ReturnType<typeof mockRefresh>>;
  readonly host: McpServer;
  readonly env: Record<string, string | null>;
  close(): Promise<void>;
  expire(): Promise<void>;
  status(): Promise<unknown>;
  readCredentials(): Promise<unknown>;
  diagnostics(): Promise<unknown>;
  clearHooks(): Promise<void>;
}

/** Real local plugin installation, native OAuth rotation, and distinct user/host MCP servers. */
export async function claudeConfigurationFixture(command: string): Promise<ClaudeConfigurationFixture> {
  // macOS tmpdir can spell /private/var as /var. Claude compares the native
  // cwd with HOME when classifying ancestors, so use one canonical spelling.
  const temporary = await mkdtemp(path.join(tmpdir(), "oar-claude-config-[scope]-"));
  const home = await realpath(temporary);
  const model = await configurationModel();
  const user = await serveMcpTools({ name: "user_config_probe", tools: [tool("user_tool")] });
  const host = await serveMcpTools({ name: "host_config_probe", tools: [tool("host_tool")] });
  let oauth: Awaited<ReturnType<typeof mockRefresh>> | null = null;
  let store: Awaited<ReturnType<typeof claudeCredentialStore>> | null = null;
  const cwd = path.join(home, "project");
  const env = cleanEnvironment(home, model.url);
  async function close(): Promise<void> {
    await oauth?.close();
    await user.close();
    await host.close();
    await model.close();
    await store?.close();
    await rm(home, { recursive: true, force: true });
  }
  try {
    await writeClaudeConfiguration(home, user.server);
    store = await claudeCredentialStore(home, env);
    const credentialStore = store, credentials = store.path;
    await checkedRun(command, ["plugin", "marketplace", "add", path.join(home, "marketplace")], cwd, env);
    await checkedRun(command, ["plugin", "install", "user-probe@oar-local-probe", "--scope", "user"], cwd, env);
    oauth = await refreshServer(home, env);
    delete env.ANTHROPIC_API_KEY;
    Object.assign(env, { HTTP_PROXY: oauth.url, HTTPS_PROXY: oauth.url, ALL_PROXY: oauth.url, NODE_EXTRA_CA_CERTS: path.join(home, "cert.pem") });
    const credential = { claudeAiOauth: { accessToken: ORIGINAL, refreshToken: REFRESH, expiresAt: Date.now() + 3_600_000, scopes: ["user:profile", "user:inference", "user:sessions:claude_code"], subscriptionType: "pro", rateLimitTier: "default_claude_pro" } };
    await store.write(credential);
    assert.deepEqual(await store.read(), credential, "The native fixture store must round-trip before a status query");
    return {
      home, cwd, credentials, credentialStorage: store.kind, debugFile: path.join(home, "native-debug.log"), model, oauth, host: host.server, close,
      env: { ...Object.fromEntries(Object.keys(process.env).map((key) => [key, null])), ...env },
      async diagnostics(): Promise<unknown> {
        const debug = await readFile(path.join(home, "native-debug.log"), "utf8").catch(() => "");
        const persisted = JSON.stringify(await credentialStore.read().catch(() => null));
        const keychain = process.platform === "darwin" ? await runExecutable("security", ["show-keychain-info"], { cwd, env, timeoutMs: 5000 }) : undefined;
        return { credentialStorage: credentialStore.kind, credentialReadable: persisted !== "null", persistedOriginal: persisted.includes(ORIGINAL),
          saveFailed: debug.includes("Failed to save OAuth tokens"), keychainReadFailed: debug.includes("[keychain] read"),
          keychainStatus: keychain?.exitCode ?? null, keychainReadable: keychain?.ok ?? null,
          nativeWarnings: debug.split("\n").filter((line) => /Failed to save OAuth|keychain.*failed|keychain.*locked|secure_storage/iu.test(line)).map((line) => line.replaceAll(ORIGINAL, "<original>").replaceAll(REFRESH, "<refresh>").replaceAll(ROTATED, "<rotated-refresh>").replaceAll(TOKEN, "<rotated-access>").replaceAll(home, "<fixture-home>")).slice(-8) };
      },
      async expire(): Promise<void> { credential.claudeAiOauth.expiresAt = 0; await credentialStore.write(credential); },
      async readCredentials(): Promise<unknown> { const value = await credentialStore.read(); return value; },
      async status(): Promise<unknown> {
        const result = await runExecutable(command, ["auth", "status", "--json"], { cwd, env, timeoutMs: 20_000 });
        assert.ok(result.ok, JSON.stringify({ phase: "auth_status", exitCode: result.exitCode, store: await credentialStore.diagnostics() }));
        return JSON.parse(result.stdout);
      },
      async clearHooks(): Promise<void> { await Promise.all(["user-hook", "project-hook", "plugin-hook"].map(async (name) => { await rm(path.join(home, name), { force: true }); })); },
    };
  } catch (error) { await close(); throw error; }
}
