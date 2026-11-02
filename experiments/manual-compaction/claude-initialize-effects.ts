/* oxlint-disable import/max-dependencies -- Standalone native protocol, local MCP/provider and filesystem controls. */
/** Repeated native provenance reads must preserve an already configured, active session. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { claudeRuntime } from "../../packages/oar/src/runtimes/claude/index.js";
import { claudeEnv } from "../../packages/oar/src/runtimes/claude/environment.js";
import { spawnLineProcess } from "../../packages/oar/src/shared/executable/index.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { startClaudeAimock } from "../../sea-trial/harness/aimock.js";

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!check()) {
    if (Date.now() >= deadline) { throw new Error("Native observation timed out"); }
    // oxlint-disable-next-line no-await-in-loop -- Observe ordered native replies with a fixed deadline.
    await delay(10);
  }
}
const installation = await claudeRuntime.installation();
assert.ok(installation.kind === "available" && installation.via === "executable");
const root = await mkdtemp(path.join(tmpdir(), "oar-initialize-effects-"));
const config = path.join(root, "config");
await mkdir(config);
const hookLog = path.join(root, "hooks.jsonl");
const hook = path.join(root, "hook.cjs");
await writeFile(hook, `require('node:fs').appendFileSync(${JSON.stringify(hookLog)}, 'started\\n');`);
const methods: string[] = [];
const mcp = createServer((request, response) => {
  if (request.method !== "POST") { response.writeHead(405).end(); return; }
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => { chunks.push(chunk); });
  request.on("end", () => {
    const message = asRecord(JSON.parse(Buffer.concat(chunks).toString()));
    const method = String(message?.method); methods.push(method);
    if (message?.id === undefined) { response.writeHead(202).end(); return; }
    let result: JsonRecord = {};
    if (method === "initialize") {
      result = { protocolVersion: asRecord(message.params)?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "provenance", version: "1" } };
    } else if (method === "tools/list") {
      result = { tools: [{ name: "probe", description: "provenance probe", inputSchema: { type: "object", properties: {} } }] };
    } else { result = { content: [{ type: "text", text: "OAR_MCP_OK" }] }; }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
});
mcp.listen(0, "127.0.0.1");
await once(mcp, "listening");
const address = mcp.address(); assert.ok(address !== null && typeof address !== "string");
const provider = await startClaudeAimock((mock) => { mock.onMessage(/[\s\S]*/u, { content: "OAR_PROVENANCE_REPLY" }); }, { captureRaw: true });
const child = spawnLineProcess(installation.command, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
  "--permission-mode", "default", "--effort", "low", "--system-prompt", "OAR_SYSTEM_MARKER", "--append-system-prompt", "OAR_APPEND_MARKER",
  "--settings", JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)}` }] }] } }),
  "--mcp-config", JSON.stringify({ mcpServers: { provenance: { type: "http", url: `http://127.0.0.1:${address.port}/mcp` } } }),
], { cwd: root, env: claudeEnv({ ...provider.env, CLAUDE_CONFIG_DIR: config }), killTree: true });
const messages: JsonRecord[] = [];
child.onLine((line) => { try { const message = asRecord(JSON.parse(line)); if (message !== null) { messages.push(message); } } catch { /* Non-protocol diagnostics are not observations. */ } });
const control = async (subtype: string, params: JsonRecord = {}): Promise<JsonRecord> => {
  const id = randomUUID();
  child.write(`${JSON.stringify({ type: "control_request", request_id: id, request: { subtype, ...params } })}\n`);
  await until(() => messages.some((message) => asRecord(message.response)?.request_id === id));
  const result = messages.map((message) => asRecord(message.response)).find((response) => response?.request_id === id);
  assert.ok(result !== undefined && result !== null);
  assert.equal(result.subtype, "success", `${subtype} failed`);
  return asRecord(result.response) ?? {};
};
const prompt = async (text: string): Promise<void> => {
  const id = randomUUID();
  child.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text }, uuid: id })}\n`);
  await until(() => messages.some((message) => message.type === "result" && message.user_message_uuid === id));
};
try {
  await child.spawned;
  await control("initialize");
  await control("set_permission_mode", { mode: "plan" });
  await prompt("OAR_BEFORE_QUERY");
  const before = await control("get_settings");
  const hooksBefore = await readFile(hookLog, "utf8");
  const initializeBefore = methods.filter((method) => method === "initialize").length;
  assert.ok(initializeBefore > 0);
  assert.ok(hooksBefore.length > 0);
  const beforeInit = messages.findLast((message) => message.type === "system" && message.subtype === "init");
  assert.equal(beforeInit?.permissionMode, "plan");
  const first = provider.raw.at(-1); assert.ok(first !== undefined);
  for (let index = 0; index < 3; index += 1) {
    // oxlint-disable-next-line no-await-in-loop -- Repeated queries belong to the same native session.
    const initialized = await control("initialize");
    const { commands } = initialized;
    assert.ok(Array.isArray(commands) && commands.some((value) => asRecord(value)?.name === "compact" && asRecord(value)?.builtin === true));
  }
  assert.deepEqual(await control("get_settings"), before);
  await prompt("OAR_AFTER_QUERY");
  const afterInit = messages.findLast((message) => message.type === "system" && message.subtype === "init");
  assert.equal(afterInit?.permissionMode, "plan");
  assert.equal(await readFile(hookLog, "utf8"), hooksBefore);
  assert.equal(methods.filter((method) => method === "initialize").length, initializeBefore);
  const last = provider.raw.at(-1); assert.ok(last !== undefined);
  const a = asRecord(first.body); const b = asRecord(last.body);
  assert.ok(a !== null && b !== null);
  assert.deepEqual(b.system, a.system);
  assert.deepEqual(b.tools, a.tools);
  assert.ok(JSON.stringify(a.system).includes("OAR_SYSTEM_MARKER"));
  assert.ok(JSON.stringify(a.system).includes("OAR_APPEND_MARKER"));
  console.log(JSON.stringify({ version: installation.version, repeatedQueries: 3, settingsUnchanged: true, permissionMode: "plan", sessionStartHooks: hooksBefore.trim().split("\n").length,
    mcpInitializations: initializeBefore, hooksNotRepeated: true, mcpNotRegisteredAgain: true, systemPromptUnchanged: true, toolCatalogUnchanged: true }, null, 2));
} finally {
  child.kill(); await child.exited; await provider.stop(); await mcp[Symbol.asyncDispose]();
  await rm(root, { recursive: true, force: true });
}
