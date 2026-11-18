/* oxlint-disable no-await-in-loop -- Each control has an isolated native process; preserve request order. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { startAppServerClient } from "../../packages/oar/src/runtimes/codex/app-server-client.js";
import { codexVersion } from "../../packages/oar/src/runtimes/codex/refusal.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { provider, providerError, rateHeaders, type Mode } from "./provider.js";

const command = process.env.OAR_CODEX_BIN;
assert.ok(command !== undefined, "Set OAR_CODEX_BIN to the isolated pinned Codex executable");
const output = resolve(process.argv[2] ?? "oar-trial-run/codex-quota-errors.json");
const root = await mkdtemp(join(tmpdir(), "oar-codex-quota-"));
const rows: unknown[] = [];

async function configure(home: string, port: number, account: boolean): Promise<Record<string, string | null>> {
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "config.toml"), ['model = "gpt-5.1"', 'model_provider = "quota_probe"', 'cli_auth_credentials_store = "file"',
    `chatgpt_base_url = "http://127.0.0.1:${port}/backend-api"`, 'sandbox_mode = "danger-full-access"', 'approval_policy = "never"',
    '[model_providers.quota_probe]', 'name = "OpenAI"', `base_url = "http://127.0.0.1:${port}/v1"`, 'env_key = "OAR_QUOTA_PROBE_KEY"',
    'wire_api = "responses"', 'request_max_retries = 0', 'stream_max_retries = 0', 'supports_websockets = false'].join("\n"));
  if (account) {
    const jwt = [Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"), Buffer.from(JSON.stringify({ email: "synthetic@example.invalid",
      "https://api.openai.com/auth": { chatgpt_plan_type: "pro", chatgpt_account_id: "synthetic-account", chatgpt_user_id: "synthetic-user" },
    })).toString("base64url"), "synthetic"].join(".");
    await writeFile(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: jwt, access_token: "synthetic-access", refresh_token: "synthetic-refresh", account_id: "synthetic-account" }, last_refresh: new Date().toISOString() }));
  }
  return { ...Object.fromEntries(Object.keys(process.env).map((key) => [key, null])), HOME: home, USERPROFILE: home, CODEX_HOME: home,
    PATH: process.env.PATH ?? "", OAR_QUOTA_PROBE_KEY: "synthetic-quota-probe", HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost" };
}

// oxlint-disable-next-line max-statements -- One ordered native lifecycle, including its two-turn compaction control and cleanup.
async function measure(native: string, path: "normal" | "compact", options: { mode: Mode; account: boolean }): Promise<void> {
  const { mode, account } = options;
  const home = join(root, `${path}-${mode}-${String(account)}`);
  const local = await provider(mode, path === "normal");
  const env = await configure(home, local.port, account);
  const notifications: { method: string; params: JsonRecord }[] = [];
  let terminal: (() => void) | undefined = undefined;
  const client = startAppServerClient(native, env, {}, home, { inheritStderr: true });
  const watchdog = setTimeout(() => { client.kill(); }, 45_000);
  client.handle({ onNotification(method, params) {
    notifications.push({ method, params });
    if (method === "turn/completed") { terminal?.(); }
  }, onServerRequest(id) { client.respond(id, { error: { code: -32_601, message: "No tools in quota probe" } }); } });
  try {
    const initialized = await client.request("initialize", { clientInfo: { name: "oar-quota-probe", version: "0" }, capabilities: { experimentalApi: true } });
    const version = codexVersion(initialized);
    client.notify("initialized", {});
    const usageBefore = account ? await client.request("account/rateLimits/read", { excludeResetCreditDetails: true }) : null;
    const thread = await client.request("thread/start", { model: "gpt-5.1", modelProvider: "quota_probe", cwd: home, approvalPolicy: "never", sandbox: "danger-full-access" });
    const id = asRecord(thread.thread)?.id;
    assert.equal(typeof id, "string");
    let done = Promise.withResolvers<void>();
    terminal = done.resolve;
    await client.request("turn/start", { threadId: id, input: [{ type: "text", text: "Seed context for quota probe." }] });
    const exited = (async (): Promise<never> => { await client.exited; throw new Error("Native exited before terminal"); })();
    await Promise.race([done.promise, exited]);
    if (path === "compact") {
      local.state.fail = true;
      done = Promise.withResolvers<void>(); terminal = done.resolve;
      await client.request("thread/compact/start", { threadId: id });
      await Promise.race([done.promise, exited]);
    }
    const usageAfter = account ? await client.request("account/rateLimits/read", { excludeResetCreditDetails: true }) : null;
    rows.push({ path, mode, account, version, providerError, responseHeaders: mode.endsWith("headers") ? rateHeaders : {},
      usageBefore, usageAfter, requests: local.requests, notifications });
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ platform: process.platform, rows }, null, 2).replaceAll(root, "<probe-root>"));
    console.log(`${path} ${mode} account=${String(account)} native=${String(version)}`);
  } finally { clearTimeout(watchdog); client.kill(); await client.exited; await local.close(); }
}

const modes: Mode[] = ["http-body", "http-headers", "sse-body", "sse-headers", "http400-body", "http400-headers"];
for (const path of ["normal", "compact"] as const) {
  for (const mode of modes) { await measure(command, path, { mode, account: false }); }
  for (const mode of ["http-headers", "sse-headers"] as const) { await measure(command, path, { mode, account: true }); }
}
