/** Native shared-thread observations against a local scripted provider only. */
/* oxlint-disable import/max-dependencies -- Combine native transport, isolated provider and probe evidence. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startCodexAimock, namespaceMcpToolCalls } from "../../sea-trial/harness/aimock.js";
import { startAppServerClient, type AppServerClient } from "../../packages/oar/src/runtimes/codex/app-server-client.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { readProcessTable, descendantsOf, killEntries, type ProcessEntry } from "../../packages/oar/src/shared/executable/process-tree.js";
import { rootsSince } from "./resources.js";
import { codexInstallation } from "../../packages/oar/src/runtimes/codex/installation.js";
import { executableInstallation } from "../../packages/oar/src/shared/installation.js";
import { ProbeTiming, probeTimeout } from "./observation.js";


function quote(value: string): string {
  return `'${value.replaceAll("'", process.platform === "win32" ? "''" : String.raw`'\''`)}'`;
}

// oxlint-disable-next-line typescript/explicit-function-return-type -- The exported fixture alias derives the complete native helper types.
export async function codexFixture(timing = new ProbeTiming()) {
  // The manual probe may wait longer on Windows; the host's installation limit stays unchanged.
  const installation = await timing.measure("installation", null, async () => { const value = process.platform === "win32"
    ? await executableInstallation("OAR_CODEX_BIN", "codex", [], ["app-server", "--help"], { readinessTimeoutMs: 60_000, versionTimeoutMs: 60_000 })()
    : await codexInstallation(); return value; });
  assert.ok(installation.kind === "available" && installation.via === "executable");
  const home = await mkdtemp(path.join(tmpdir(), "oar-codex-sharing-"));
  const cwds = [path.join(home, "a"), path.join(home, "b")];
  await Promise.all(cwds.map(async (cwd) => { await mkdir(cwd); }));
  const tool = path.join(home, "tool.mjs");
  await writeFile(tool, [
    "import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';",
    "if(process.argv[2]==='cwd')console.log('CWD_RESULT='+process.cwd());",
    "else { const child=spawn(process.execPath,['-e','setTimeout(()=>{},300000)'],{stdio:'ignore'});",
    "writeFileSync(process.argv[3],JSON.stringify({parent:process.pid,child:child.pid}));",
    "console.log('OWNED_COMMAND_STARTED');setTimeout(()=>{},300000);}",
  ].join("\n"));
  const mcp = path.join(home, "mcp.mjs");
  await writeFile(mcp, [
    "import { createInterface } from 'node:readline';",
    "createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;let result={};",
    "if(q.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'scope',version:'1'}};",
    "if(q.method==='tools/list')result={tools:[{name:'echo',description:'Read the per-session marker',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]};",
    "if(q.method==='tools/call')result={content:[{type:'text',text:'MCP_RESULT='+process.argv[2]+' input='+q.params.arguments.text}]};",
    String.raw`process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\n');});`,
  ].join("\n"));
  const stages = new Map<string, number>();
  const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const seen: { key: string; stage: number; request: unknown }[] = [];
  const provider = await startCodexAimock((mock) => {
    mock.on({ predicate: () => true }, async (request) => {
      const user = request.messages.findLast((message) => message.role === "user" && JSON.stringify(message.content).includes("OAR_SHARE_"));
      const key = /OAR_SHARE_(?<key>[A-Z]+_[a-z]+)/u.exec(JSON.stringify(user))?.groups?.key ?? "metadata_echo";
      const stage = stages.get(key) ?? 0;
      stages.set(key, stage + 1); seen.push({ key, stage, request });
      const [label = "A", phase] = key.split("_");
      if (stage === 0 && (phase === "cwd" || phase === "background")) {
        const args = [process.execPath, tool, phase === "cwd" ? "cwd" : "background", path.join(home, `${label}.json`)];
        const cmd = `${process.platform === "win32" ? "& " : ""}${args.map((arg) => quote(arg)).join(" ")}`;
        return { toolCalls: [{ name: "exec_command", arguments: JSON.stringify({ cmd, yield_time_ms: 1000, max_output_tokens: 500 }), id: `tool-${key}` }] };
      }
      if (stage === 0 && phase === "mcp") {
        return { toolCalls: [{ name: "mcp__scope__echo", arguments: JSON.stringify({ text: label }), id: `tool-${key}` }] };
      }
      if (stage === 0 && phase === "spawn") {
        return { toolCalls: [{ name: "spawn_agent", arguments: JSON.stringify({ message: "OAR_SHARE_CHILD_echo", task_name: "evidence_child", fork_turns: "none" }), id: `tool-${key}` }] };
      }
      if (phase === "hold") {
        const gate = Promise.withResolvers<void>(); gates.set(key, gate); await gate.promise;
      }
      return { content: `ANSWER_${key}` };
    });
  }, { captureRaw: true, rewriteResponse: (body) => namespaceMcpToolCalls(body)
    .replaceAll('"name":"spawn_agent"', '"name":"spawn_agent","namespace":"collaboration"'), warmHome: false });
  const environment = { ...Object.fromEntries(Object.keys(process.env).map((key) => [key, null])), HOME: home, USERPROFILE: home,
    PATH: process.env.PATH ?? "", ...Object.fromEntries(Object.entries(process.env).filter(([key]) => ["systemroot", "windir", "comspec", "pathext", "temp", "tmp"].includes(key.toLowerCase()))), NO_PROXY: "*", ...provider.env };
  const clients: AppServerClient[] = [];
  const crashDescendants: ProcessEntry[] = [];
  const nativePids = new Map<AppServerClient, number>();
  const events: { client: number; method: string; params: JsonRecord }[] = [];
  const calls: { client: number; method: string; params: JsonRecord; result?: JsonRecord; error?: string }[] = [];
  const request = async (client: AppServerClient, method: string, params: JsonRecord): Promise<JsonRecord> => {
    const row: (typeof calls)[number] = { client: clients.indexOf(client), method, params }; calls.push(row);
    const limit = probeTimeout(30_000);
    const timer = setTimeout(() => { client.kill(); }, limit);
    try { const result = await timing.measure(method, limit, async () => { const value = await client.request(method, params); return value; }); row.result = result; return result; }
    catch (error) { row.error = String(error); throw error; }
    finally { clearTimeout(timer); }
  };
  const connect = async (): Promise<AppServerClient> => {
    const before = readProcessTable();
    const client = startAppServerClient(process.env.OAR_CODEX_BIN ?? "codex", environment,
      { sandbox_mode: '"danger-full-access"', "features.code_mode": "false", "features.multi_agent_v2": "true" }, home);
    const index = clients.length; clients.push(client);
    client.handle({ onNotification: (method, params) => { events.push({ client: index, method, params }); },
      onServerRequest: (_id, method, params) => { events.push({ client: index, method, params }); } });
    await request(client, "initialize", { clientInfo: { name: "oar-sharing-evidence", version: "1" }, capabilities: { experimentalApi: true } });
    const roots = rootsSince(before); assert.equal(roots.length, 1); const [root] = roots; assert.ok(root);
    const native = [...readProcessTable().values()].find((entry) => entry.ppid === root.pid) ?? root;
    nativePids.set(client, native.pid);
    client.notify("initialized", {}); return client;
  };
  const open = async (client: AppServerClient, label: "A" | "B"): Promise<string> => {
    const result = await request(client, "thread/start", { cwd: cwds[label === "A" ? 0 : 1], model: "gpt-5.1", approvalPolicy: "never",
      config: { mcp_servers: { scope: { command: process.execPath, args: [mcp, label], enabled: true } } } });
    const id = asRecord(result.thread)?.id; assert.equal(typeof id, "string"); return String(id);
  };
  const start = async (client: AppServerClient, threadId: string, key: string): Promise<string> => {
    const result = await request(client, "turn/start", { threadId, input: [{ type: "text", text: `OAR_SHARE_${key}` }] });
    const id = asRecord(result.turn)?.id; assert.equal(typeof id, "string"); return String(id);
  };
  const ended = (threadId: string, turnId: string): JsonRecord | null => asRecord(events.find((event) => event.method === "turn/completed"
    && event.params.threadId === threadId && asRecord(event.params.turn)?.id === turnId)?.params.turn);
  const turn = async (client: AppServerClient, threadId: string, key: string): Promise<JsonRecord> => {
    const id = await start(client, threadId, key); await timing.until(() => ended(threadId, id) !== null, `${key} completed`);
    const result = ended(threadId, id); assert.ok(result); return result;
  };
  return { timing, installation, home, cwds, seen, stages, gates, provider, clients, events, calls, connect, request, open, start, ended, turn,
    crash(client: AppServerClient): void { const pid = nativePids.get(client); assert.ok(pid !== undefined); crashDescendants.push(...descendantsOf(readProcessTable(), pid)); process.kill(pid, "SIGKILL"); },
    async stop(): Promise<void> {
      killEntries(crashDescendants, readProcessTable());
      for (const gate of gates.values()) { gate.resolve(); }
      await Promise.all(clients.map(async (client) => { client.kill(); await client.exited; }));
      await provider.stop(); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}
export type CodexFixture = Awaited<ReturnType<typeof codexFixture>>;
