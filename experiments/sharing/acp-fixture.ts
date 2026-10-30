/** One native ACP connection, several sessions, scripted local model only. */
/* oxlint-disable import/max-dependencies -- Compose native profiles, local providers and the host terminal implementation. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultRuntimes } from "../../packages/oar/src/index.js";
import { createAcpClientApp } from "../../packages/oar/src/shared/acp/client-app.js";
import { createAcpTerminalHost, type AcpTerminalHost } from "../../packages/oar/src/shared/acp/terminal.js";
import { startAcpProcess, withAcpDeadline } from "../../packages/oar/src/shared/acp/process.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { kimiAcpProfile } from "../../packages/oar/src/runtimes/kimi/session.js";
import { grokAcpProfile } from "../../packages/oar/src/runtimes/grok/session.js";
import { opencodeAcpProfile } from "../../packages/oar/src/runtimes/opencode/session.js";
import { antigravityAcpProfile } from "../../packages/oar/src/runtimes/antigravity/session.js";
import { startAntigravityAimock, startGrokAimock, startKimiAimock, startOpencodeAimock } from "../../sea-trial/harness/aimock-acp.js";
import { readProcessTable, descendantsOf, killEntries, type ProcessEntry } from "../../packages/oar/src/shared/executable/process-tree.js";
import { rootsSince } from "./resources.js";
import { ProbeTiming, powershellCommand, probeTimeout } from "./observation.js";

export type AcpId = "kimi" | "grok" | "opencode" | "antigravity";
export function acpId(value: string): AcpId {
  assert.ok(value === "kimi" || value === "grok" || value === "opencode" || value === "antigravity"); return value;
}
const profiles = { kimi: kimiAcpProfile, grok: grokAcpProfile, opencode: opencodeAcpProfile, antigravity: antigravityAcpProfile };
const factories = { kimi: startKimiAimock, grok: startGrokAimock, opencode: startOpencodeAimock, antigravity: startAntigravityAimock };
function quoted(value: string): string { return process.platform === "win32" ? `"${value.replaceAll('"', String.raw`\"`)}"` : `'${value.replaceAll("'", String.raw`'\''`)}'`; }

// oxlint-disable-next-line typescript/explicit-function-return-type -- The exported alias retains the inferred native fixture shape without duplicating it.
export async function acpFixture(id: AcpId, timing = new ProbeTiming()) {
  const installation = await timing.measure("installation", null, async () => { const value = await defaultRuntimes.require(id).installation?.(); return value; }); assert.ok(installation?.kind === "available" && installation.via === "executable");
  const home = await mkdtemp(path.join(tmpdir(), "oar-acp-sharing-"));
  const cwds = [path.join(home, "a"), path.join(home, "b")]; await Promise.all(cwds.map(async (cwd) => { await mkdir(cwd); }));
  const script = path.join(home, "tool.cjs");
  await writeFile(script, [
    "const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');",
    "if(process.argv[2]==='cwd')console.log('CWD_RESULT='+process.cwd());",
    "else{const child=spawn(process.execPath,['-e','setTimeout(()=>{},300000)'],{stdio:'ignore'});",
    "writeFileSync(process.argv[3],JSON.stringify({parent:process.pid,child:child.pid}));console.log('TOOL_READY');setTimeout(()=>{},300000);}",
  ].join("\n"));
  const mcp = path.join(home, "mcp.cjs");
  await writeFile(mcp, [
    "require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;let result={};",
    "if(q.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'scope',version:'1'}};",
    "if(q.method==='tools/list')result={tools:[{name:'echo',description:'Return session marker',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]};",
    "if(q.method==='tools/call')result={content:[{type:'text',text:'MCP_RESULT='+process.argv[2]+' input='+q.params.arguments.text}]};",
    String.raw`process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\n');});`,
  ].join("\n"));
  const seen: { key: string; stage: number; request: unknown }[] = [];
  const stages = new Map<string, number>(); const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const provider = await factories[id]((mock) => {
    mock.on({ predicate: () => true }, async (request) => {
      const user = request.messages.findLast((message) => message.role === "user" && /ACP_SHARE_[AB]_[a-z]+/u.test(JSON.stringify(message.content)));
      const key = /ACP_SHARE_(?<key>[AB]_[a-z]+)/u.exec(JSON.stringify(user))?.groups?.key ?? "metadata_echo";
      const stage = stages.get(key) ?? 0; stages.set(key, stage + 1); seen.push({ key, stage, request });
      const [label, phase] = key.split("_"); const codeMode = request.tools?.some((tool) => tool.function.name === "execute") ?? false;
      let call: { name: string; arguments: JsonRecord } | null = null;
      if (stage === 0 && (phase === "cwd" || phase === "tool")) {
        const args = [process.execPath, script, phase === "cwd" ? "cwd" : "background", path.join(home, `${label}.json`)];
        const command = process.platform === "win32" && (id === "opencode" || id === "antigravity")
          ? powershellCommand(args) : args.map((arg) => quoted(arg)).join(" ");
        if (id === "kimi") { call = { name: "Bash", arguments: { command } }; }
        if (id === "grok") { call = { name: "run_terminal_command", arguments: { command, description: "Owned test command", block_until_ms: 1000 } }; }
        if (id === "opencode") { call = { name: codeMode ? "shell" : "bash", arguments: { command, description: "Owned test command" } }; }
        if (id === "antigravity") { call = { name: "run_command", arguments: { CommandLine: command, Cwd: cwds[label === "A" ? 0 : 1], WaitMsBeforeAsync: 1000, toolSummary: "Check isolation", toolAction: "Checking" } }; }
      }
      if (stage === 0 && phase === "mcp") {
        if (id === "kimi") { call = { name: "mcp__scope__echo", arguments: { text: label } }; }
        if (id === "grok") { call = { name: "use_tool", arguments: { tool_name: "scope__echo", tool_input: { text: label } } }; }
        if (id === "opencode") { call = codeMode ? { name: "execute", arguments: { code: `return await tools.scope.echo(${JSON.stringify({ text: label })});` } } : { name: "scope_echo", arguments: { text: label } }; }
        if (id === "antigravity") { call = { name: "call_mcp_tool", arguments: { ServerName: "scope", ToolName: "echo", Arguments: { text: label }, toolSummary: "Check isolation", toolAction: "Checking" } }; }
      }
      if (phase === "child") {
        const prompt = `ACP_SHARE_${label}_childreply`;
        if (stage === 0 && id === "kimi") { call = { name: "Agent", arguments: { prompt, description: "Check child routing", subagent_type: "coder", run_in_background: false } }; }
        if (stage === 0 && id === "grok") { call = { name: "spawn_subagent", arguments: { prompt, description: "Check child routing", background: false } }; }
        if (stage === 0 && id === "opencode") { call = codeMode
          ? { name: "subagent", arguments: { agent: "general", description: "Check child routing", prompt } }
          : { name: "task", arguments: { subagent_type: "general", description: "Check child routing", prompt } }; }
        if (id === "antigravity") {
          if (stage === 0) { call = { name: "define_subagent", arguments: { name: "scope_check", description: "Check child routing", system_prompt: "Answer the supplied marker.", toolSummary: "Child routing check", toolAction: "Checking child routing" } }; }
          if (stage === 1) { call = { name: "invoke_subagent", arguments: { Subagents: [{ TypeName: "scope_check", Role: "Routing observer", Prompt: prompt }], toolSummary: "Child routing check", toolAction: "Checking child routing" } }; }
        }
      }
      if (call !== null) { return { toolCalls: [{ id: `call-${key}`, name: call.name, arguments: JSON.stringify(call.arguments) }] }; }
      if (phase === "hold" || phase === "exit" || phase === "tool") { const gate = gates.get(key) ?? Promise.withResolvers<void>(); gates.set(key, gate); await gate.promise; }
      return { content: `ANSWER_${key}` };
    });
  });
  const cleared = Object.fromEntries(Object.keys(process.env).map((key) => [key, null]));
  const hostEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["systemroot", "windir", "comspec", "pathext", "temp", "tmp"].includes(key.toLowerCase())));
  const env = Object.fromEntries(Object.entries({ ...cleared,
    PATH: process.env.PATH ?? "", ...hostEnvironment, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"), XDG_STATE_HOME: path.join(home, "state"), XDG_CACHE_HOME: path.join(home, "cache"), NO_PROXY: "*", ...provider.env })
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const profile = profiles[id]; const terminals = new Map<string, AcpTerminalHost>();
  const terminalFor = (sessionId: string): AcpTerminalHost => { const host = terminals.get(sessionId); assert.ok(host, "known terminal owner"); return host; };
  const terminal: AcpTerminalHost = {
    create: async (params) => { const reply = await terminalFor(params.sessionId).create(params); return reply; },
    output: (params) => terminalFor(params.sessionId).output(params),
    waitForExit: async (params) => { const reply = await terminalFor(params.sessionId).waitForExit(params); return reply; },
    kill: (params) => terminalFor(params.sessionId).kill(params),
    release: async (params) => { const reply = await terminalFor(params.sessionId).release(params); return reply; },
    dispose: async () => { await Promise.all([...terminals.values()].map(async (host) => { await host.dispose(); })); },
  };
  const events: { method: string; params: JsonRecord }[] = []; const calls: unknown[] = [];
  const app = createAcpClientApp(terminal, { update: (params) => { events.push({ method: "session/update", params: { ...params } }); },
    requested: (requestId, method, params) => { calls.push({ requestId, method, params }); }, answered: (requestId, reply) => { calls.push({ requestId, reply }); },
    extension: (method, params) => { events.push({ method, params }); }, extensionNotifications: profile.extensionNotifications ?? [] });
  const children: ReturnType<typeof startAcpProcess>[] = [];
  const crashDescendants: ProcessEntry[] = [];
  const nativePids = new Map<(typeof children)[number], number>();
  const request = async (child: (typeof children)[number], method: string, params: JsonRecord): Promise<JsonRecord> => {
    try {
      const limit = probeTimeout(method === "session/prompt" ? 60_000 : 30_000);
      const result = await timing.measure(method, limit, async () => { const value = await withAcpDeadline(child, method, limit,
        async (opts) => { const reply = await child.connection.agent.request(method, params, opts); return reply; }); return value; });
      calls.push({ method, params, result }); return asRecord(result) ?? {};
    } catch (error) { calls.push({ method, params, error: String(error) }); throw error; }
  };
  const connect = async (): Promise<{ child: ReturnType<typeof startAcpProcess>; initialized: JsonRecord }> => {
    const before = readProcessTable();
    const child = startAcpProcess(installation.command, typeof profile.args === "function" ? profile.args({ cwd: home }) : profile.args, app, { cwd: home, env });
    children.push(child);
    const initialized = await request(child, "initialize", { protocolVersion: 1, clientCapabilities: { fs: {}, terminal: true },
      clientInfo: { name: "oar-sharing-evidence", version: "1" }, _meta: profile.initializeMeta?.({ cwd: home }) ?? {} });
    const auth = profile.selectAuthMethod?.(initialized); if (auth !== undefined) { await request(child, "authenticate", { methodId: auth }); }
    const [root, extra] = rootsSince(before); assert.ok(root && extra === undefined);
    nativePids.set(child, root.pid);
    return { child, initialized };
  };
  const mcpServers = (label: "A" | "B"): JsonRecord[] => [{ name: "scope", command: process.execPath, args: [mcp, label], env: [] }];
  const open = async (connection: Awaited<ReturnType<typeof connect>>, label: "A" | "B", withMcp = true): Promise<{ id: string; cwd: string; response: JsonRecord; label: "A" | "B" }> => {
    const cwd = cwds[label === "A" ? 0 : 1]; assert.ok(cwd !== undefined);
    const response = await request(connection.child, "session/new", { cwd, mcpServers: withMcp ? mcpServers(label) : [], _meta: profile.sessionMeta?.({ cwd }, connection.initialized) ?? {} });
    assert.equal(typeof response.sessionId, "string"); const sessionId = String(response.sessionId);
    terminals.set(sessionId, createAcpTerminalHost(cwd, env, { shellCommand: id === "grok" }));
    await profile.configureSession?.({ request: async (method, params) => { const result = await request(connection.child, method, params); return result; }, sessionId, response, options: { cwd } });
    return { id: sessionId, cwd, response, label };
  };
  const prompt = async (child: (typeof children)[number], sessionId: string, key: string): Promise<JsonRecord> => {
    const result = await request(child, "session/prompt", { sessionId, prompt: [{ type: "text", text: `ACP_SHARE_${key}` }] }); return result;
  };
  return { timing, id, home, cwds, installation, provider, profile, stages, seen, gates, children, terminals, terminalFor, calls, events,
    connect, request, open, prompt, mcpServers,
    crash(child: (typeof children)[number]): void { const pid = nativePids.get(child); assert.ok(pid !== undefined); crashDescendants.push(...descendantsOf(readProcessTable(), pid)); process.kill(pid, "SIGKILL"); },
    async stop(): Promise<void> {
      killEntries(crashDescendants, readProcessTable());
      for (const gate of gates.values()) { gate.resolve(); }
      await Promise.all(children.map(async (child) => { child.kill(); await child.exited; }));
      await terminal.dispose(); await provider.stop(); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}
export type AcpFixture = Awaited<ReturnType<typeof acpFixture>>;
