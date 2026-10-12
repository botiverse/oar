/* oxlint-disable eslint/max-statements, eslint/max-lines-per-function -- Keep the independent native reproduction and its cleanup together. */
/**
 * Direct OpenCode ACP MCP resume probe. No OAR imports, account or login.
 * node experiments/opencode-mcp-resume-native.ts <binary> <output-dir> [resume-count=6]
 * Uses free opencode/big-pickle. Each turn runs in a fresh native process.
 * October 12, 2026: investigates the intermittent catalog failure in oar#371.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";

const [command, output, countText = "6"] = process.argv.slice(2);
assert.ok(command !== undefined && output !== undefined, "usage: <binary> <output-dir> [resume-count]");
assert.ok(process.platform !== "win32", "this diagnostic uses POSIX process groups for cleanup");
const count = Number(countText);
assert.ok(Number.isSafeInteger(count) && count > 0);
const binary = path.resolve(command);
const out = path.resolve(output);
const root = await mkdtemp(path.join(tmpdir(), "opencode-native-mcp-"));
const cwd = path.join(root, "project");
const home = path.join(root, "home");
await Promise.all([out, cwd, home].map(async (directory) => { await mkdir(directory, { recursive: true }); }));
const env: NodeJS.ProcessEnv = {};
for (const key of ["PATH", "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
  if (process.env[key] !== undefined) { env[key] = process.env[key]; }
}
Object.assign(env, {
  HOME: home, OPENCODE_TEST_HOME: home,
  XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
  XDG_STATE_HOME: path.join(root, "state"), XDG_CACHE_HOME: path.join(root, "cache"),
  OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
});
const version = execFileSync(binary, ["--version"], { env, encoding: "utf8" }).trim();
const server = path.join(root, "echo.mjs");
await writeFile(server, `
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const send = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
  switch (message.method) {
    case "initialize":
      send({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "native-echo", version: "1" } });
      break;
    case "tools/list": send({ tools: [{ name: "echo", description: "Echo text with a native marker", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] }); break;
    case "tools/call": send({ content: [{ type: "text", text: "native-echo:" + message.params.arguments.text }] }); break;
    case "ping": send({}); break;
    default: process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unknown method" } }) + "\\n");
  }
});
`);
const mcpServers = [{ name: "echo", command: process.execPath, args: [server], env: [] }];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> { return isObject(value) ? value : {}; }
interface Wire { at: number; direction: "in" | "out"; message: unknown }

async function turn(round: number, resume: string | null): Promise<{ id: string; facts: unknown }> {
  const wire: Wire[] = [];
  const stderr: string[] = [];
  const child = spawn(binary, ["acp"], { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  let id = resume;
  const closed = Promise.withResolvers<void>();
  child.once("close", () => {
    for (const waiter of pending.values()) { waiter.reject(new Error("native process exited")); }
    pending.clear();
    closed.resolve();
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr.push(chunk.toString()); });
  child.on("error", (error) => { for (const waiter of pending.values()) { waiter.reject(error); } });
  const send = (message: unknown): void => {
    wire.push({ at: Date.now(), direction: "out", message });
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message: unknown = JSON.parse(line);
    wire.push({ at: Date.now(), direction: "in", message });
    const data = object(message);
    if (typeof data.method === "string" && data.id !== undefined) {
      const { options } = object(data.params);
      const option = Array.isArray(options) ? options.map((item: unknown) => object(item)).find((item) => item.kind === "allow_once") : undefined;
      send(data.method === "session/request_permission" && option !== undefined
        ? { jsonrpc: "2.0", id: data.id, result: { outcome: { outcome: "selected", optionId: option.optionId } } }
        : { jsonrpc: "2.0", id: data.id, error: { code: -32_601, message: "Client method unsupported" } });
    } else if (typeof data.id === "number") {
      const waiter = pending.get(data.id);
      pending.delete(data.id);
      if (data.error === undefined) { waiter?.resolve(data.result); }
      else { waiter?.reject(new Error(JSON.stringify(data.error))); }
    }
  });
  const request = async (method: string, params: unknown, timeout = 30_000): Promise<unknown> => {
    const requestId = nextId++;
    const response = Promise.withResolvers<unknown>();
    pending.set(requestId, response);
    const timer = setTimeout(() => { pending.delete(requestId); response.reject(new Error(`timeout: ${method}`)); }, timeout);
    try {
      send({ jsonrpc: "2.0", id: requestId, method, params });
      return await response.promise;
    } finally { clearTimeout(timer); pending.delete(requestId); }
  };
  try {
    await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "native-mcp-repro", version: "1" } });
    const opened = object(await request(resume === null ? "session/new" : "session/resume", {
      cwd, mcpServers, ...(resume === null ? {} : { sessionId: resume }),
    }));
    if (resume === null) { assert.equal(typeof opened.sessionId, "string"); id = String(opened.sessionId); }
    assert.ok(id !== null);
    await request("session/set_config_option", { sessionId: id, configId: "model", value: "opencode/big-pickle" });
    const marker = `NATIVE_MCP_${String(round)}`;
    const promptStart = Date.now();
    const result = await request("session/prompt", {
      sessionId: id,
      prompt: [{ type: "text", text: `Call the echo MCP tool with text ${marker}. Reply with the exact tool result. Do not use shell or fake a tool result.` }],
    }, 180_000);
    const toolResults = wire.filter(({ direction, message }) => {
      const update = object(object(object(message).params).update);
      return direction === "in" && update.sessionUpdate === "tool_call_update" && update.status === "completed";
    });
    const echoCalled = JSON.stringify(toolResults).includes(`native-echo:${marker}`);
    if (!echoCalled) { process.exitCode = 1; }
    return { id, facts: { round, method: resume === null ? "session/new" : "session/resume", promptStart, result, echoCalled } };
  } finally {
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      process.kill(-child.pid, "SIGTERM");
      const kill = setTimeout(() => { if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) { process.kill(-child.pid, "SIGKILL"); } }, 3000);
      await closed.promise;
      clearTimeout(kill);
    }
    lines.close();
    await writeFile(path.join(out, `round-${String(round)}.wire.jsonl`), `${wire.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    await writeFile(path.join(out, `round-${String(round)}.stderr.txt`), stderr.join(""));
  }
}

const facts: unknown[] = [];
let sessionId: string | null = null;
try {
  for (let round = 0; round <= count; round++) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each process resumes the preceding process's session.
    const result = await turn(round, sessionId);
    sessionId = result.id;
    facts.push(result.facts);
    console.log(JSON.stringify(result.facts));
  }
} finally {
  const db = new DatabaseSync(path.join(root, "data", "opencode", "opencode.db"), { readOnly: true });
  try {
    const messages = db.prepare("SELECT seq, type, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq").all(sessionId ?? "");
    await writeFile(path.join(out, "native-messages.json"), JSON.stringify(messages, null, 2));
    const catalogUpdates = messages.filter((message) => message.type === "system" && typeof message.data === "string" && message.data.includes("Code Mode tool catalog"));
    const nativeLog = await readFile(path.join(root, "data", "opencode", "log", "opencode.log"), "utf8");
    await writeFile(path.join(out, "native.log"), nativeLog);
    const connections = nativeLog.split("\n").filter((line) => line.includes("mcp connected"));
    await writeFile(path.join(out, "report.json"), JSON.stringify({ version, credentials: "none", root, sessionId, facts, catalogUpdates, connections }, null, 2));
  } finally { db.close(); }
  console.log(`Native evidence retained in ${out}; isolated state in ${root}`);
}
