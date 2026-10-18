/**
 * Native Antigravity settings and credential persistence, without an account.
 * OAR_ANTIGRAVITY_BIN=/path/to/agy_acp_server.par pnpm tsx experiments/antigravity-native-settings.ts
 * Keep localharness_external beside the server. Uses the real ACP server,
 * dummy Gemini credentials, a local scripted provider and local MCP servers.
 * Deliberately bypasses OAR's MCP credential refusal with harmless sentinels.
 *
 * Observed 1.4.1, 2026-10-18: append reaches systemInstruction on new/resume;
 * omitting it on resume clears it. thinking_level low/high reaches the
 * provider; plain resume chose high after low. Model ids are grouped families.
 * MCP env/header sentinels remain in the conversation database and WAL.
 * Report the inherited umask (Linux) and temporary home mode alongside file modes;
 * the previously observed 0600 is not a runtime-enforced guarantee.
 * The temporary home and all its data are removed on exit.
 */
/* oxlint-disable eslint/no-await-in-loop, typescript/promise-function-async -- Ordered native RPCs and directory traversal; deadline callbacks return SDK promises. */
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createAcpClient, methods, startAcpProcess, withAcpDeadline } from "../packages/oar/src/shared/acp/process.js";
import { asRecord, asRecordList, type JsonRecord } from "../packages/oar/src/shared/json.js";
import { startAntigravityAimock } from "../sea-trial/harness/aimock-acp.js";
import { startHttpEcho, ECHO_SERVER } from "../sea-trial/vendor/support/echo-mcp.js";

const command = process.env.OAR_ANTIGRAVITY_BIN;
if (command === undefined) {
  throw new Error("Set OAR_ANTIGRAVITY_BIN to the server under test");
}
const envSentinel = "OAR_FAKE_ENV_140_8238";
const headerSentinel = "OAR_FAKE_HEADER_140_9741";
const firstAppend = "OAR_APPEND_NEW_140";
const nextAppend = "OAR_APPEND_RESUME_140";

/** Read Linux's reported value without process.umask()'s process-wide mutation. */
async function inheritedUmask(): Promise<string | undefined> {
  if (process.platform !== "linux") { return undefined; }
  const status = await readFile("/proc/self/status", "utf8");
  return /^Umask:\s+(?<mask>[0-7]+)$/mu.exec(status)?.groups?.mask;
}

async function storedCredentials(directory: string): Promise<readonly object[]> {
  const found: object[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...await storedCredentials(file));
    } else {
      const data = await readFile(file);
      const env = data.includes(Buffer.from(envSentinel));
      const headers = data.includes(Buffer.from(headerSentinel));
      if (env || headers) {
        const info = await stat(file);
        found.push({ file: entry.name.replace(/^[0-9a-f-]{36}/u, "<session>"), env, headers, mode: (info.mode & 0o777).toString(8) });
      }
    }
  }
  return found;
}

const env = await startAntigravityAimock((mock) => { mock.onMessage(/PROBE_OK/u, { content: "PROBE_OK" }); });
const nativeHome = env.env.HOME;
assert.ok(nativeHome !== undefined, "the isolated harness must supply HOME");
const http = await startHttpEcho();
const app = createAcpClient({ name: "oar-native-settings" })
  .onNotification(methods.client.session.update, () => {});
const baseEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => ["PATH", "LANG", "LC_ALL", "TMPDIR", "SHELL", "SystemRoot"].includes(key)));
const start = (): ReturnType<typeof startAcpProcess> => startAcpProcess(command, process.platform === "linux" ? ["--uid="] : [], app, {
  cwd: nativeHome,
  env: { ...baseEnv, ...env.env },
});
let native = start();
const request = async (method: string, params: JsonRecord): Promise<JsonRecord> => asRecord(await withAcpDeadline(native, method, 60_000,
  (options) => native.connection.agent.request(method, params, options))) ?? {};
const stop = async (): Promise<void> => { native.kill(); await native.exited; };
const initialize = (): Promise<JsonRecord> => request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "oar-native-settings", version: "0.0.0" } });
const append = (text: string): JsonRecord => ({ _meta: { antigravity: { systemPrompt: { append: text } } } });
const servers = [
  { name: "echo", command: process.execPath, args: [ECHO_SERVER], env: [{ name: "OAR_ECHO_TOKEN", value: envSentinel }] },
  { type: "http", name: "remote", url: http.url, headers: [{ name: "Authorization", value: headerSentinel }] },
];
const prompt = async (sessionId: string): Promise<readonly object[]> => {
  const offset = env.raw.length;
  await request("session/prompt", { sessionId, prompt: [{ type: "text", text: "PROBE_OK" }] });
  return env.raw.slice(offset).map(({ body: value }) => {
    const body = asRecord(value);
    const system = JSON.stringify(body?.systemInstruction ?? null);
    return {
      firstAppend: system.includes(firstAppend),
      resumedAppend: system.includes(nextAppend),
      thinking: asRecord(asRecord(body?.generationConfig)?.thinkingConfig)?.thinkingLevel,
    };
  });
};

try {
  const initialized = await initialize();
  const opened = await request("session/new", { cwd: nativeHome, mcpServers: servers, ...append(firstAppend) });
  const { sessionId } = opened;
  if (typeof sessionId !== "string") {
    throw new TypeError("session/new returned no id");
  }
  const configOptions = asRecordList(opened.configOptions);
  const model = configOptions.find((option) => option.id === "model");
  const menus: unknown[] = [];
  for (const option of asRecordList(model?.options)) {
    const switched = await request("session/set_config_option", { sessionId, configId: "model", value: option.value });
    menus.push(switched.configOptions);
  }
  await request("session/set_config_option", { sessionId, configId: "model", value: "gemini-3.8-flash" });
  const low = await request("session/set_config_option", { sessionId, configId: "thinking_level", value: "low" });
  const first = await prompt(sessionId);
  await stop();
  native = start();
  await initialize();
  const resumed = await request("session/resume", { sessionId, cwd: nativeHome, mcpServers: [], ...append(nextAppend) });
  const high = await request("session/set_config_option", { sessionId, configId: "thinking_level", value: "high" });
  const second = await prompt(sessionId);
  await stop();
  native = start();
  await initialize();
  await request("session/resume", { sessionId, cwd: nativeHome, mcpServers: [] });
  const omitted = await prompt(sessionId);
  await stop();
  const homeInfo = await stat(nativeHome);
  console.log(JSON.stringify({
    umask: await inheritedUmask(), homeMode: (homeInfo.mode & 0o777).toString(8),
    capabilities: initialized.agentCapabilities,
    configOptions, menus,
    low: low.configOptions, resumed: resumed.configOptions, high: high.configOptions,
    first, second, omitted,
    storedCredentials: await storedCredentials(nativeHome),
  }, null, 2));
} finally {
  await stop();
  http.stop();
  await env.stop();
}
