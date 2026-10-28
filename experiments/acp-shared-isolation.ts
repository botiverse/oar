/** Two native sessions on one ACP connection, with local providers and owned tools.
 * pnpm tsx experiments/acp-shared-isolation.ts <output-dir> kimi|grok|opencode|antigravity
 * Optional --dispose-target-terminals applies host cleanup after native session/close.
 */
/* oxlint-disable eslint/no-await-in-loop -- Native observations are ordered and bounded. */
/* oxlint-disable import/max-dependencies -- This probe composes the existing native profiles and fixtures. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { defaultRuntimes } from "../packages/oar/src/index.js";
import { createAcpClientApp } from "../packages/oar/src/shared/acp/client-app.js";
import { createAcpTerminalHost, type AcpTerminalHost } from "../packages/oar/src/shared/acp/terminal.js";
import { startAcpProcess, withAcpDeadline } from "../packages/oar/src/shared/acp/process.js";
import { asRecord, type JsonRecord } from "../packages/oar/src/shared/json.js";
import { kimiAcpProfile } from "../packages/oar/src/runtimes/kimi/session.js";
import { grokAcpProfile } from "../packages/oar/src/runtimes/grok/session.js";
import { opencodeAcpProfile } from "../packages/oar/src/runtimes/opencode/session.js";
import { antigravityAcpProfile } from "../packages/oar/src/runtimes/antigravity/session.js";
import { startAntigravityAimock, startGrokAimock, startKimiAimock, startOpencodeAimock } from "../sea-trial/harness/aimock-acp.js";
import { forest, isolatedEnvironment, newRoots, processTable, survivors, type LinuxProcess } from "./support/linux-resources.js";

const out = path.resolve(process.argv[2] ?? "oar-trial-run/acp-isolation");
const id = process.argv[3] ?? "kimi";
const disposeTargetTerminals = process.argv.includes("--dispose-target-terminals");
assert.ok(id === "kimi" || id === "grok" || id === "opencode" || id === "antigravity");
const profiles = { kimi: kimiAcpProfile, grok: grokAcpProfile, opencode: opencodeAcpProfile, antigravity: antigravityAcpProfile };
const factories = { kimi: startKimiAimock, grok: startGrokAimock, opencode: startOpencodeAimock, antigravity: startAntigravityAimock };
const home = await mkdtemp(path.join(tmpdir(), "oar-acp-isolation-"));
const cwds = [path.join(home, "cwd-0"), path.join(home, "cwd-1")];
await mkdir(out, { recursive: true });
await Promise.all(cwds.map(async (cwd) => { await mkdir(cwd); }));
const toolScript = path.join(home, "tool.py");
await writeFile(toolScript, [
  "import json, os, subprocess, sys, time",
  "if sys.argv[1] == 'cwd':",
  "    print('CWD_RESULT=' + os.getcwd(), flush=True)",
  "else:",
  "    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(45)'])",
  "    with open(sys.argv[2], 'w') as f: json.dump({'parent': os.getpid(), 'child': child.pid}, f)",
  "    print('TOOL_STARTED', flush=True)",
  "    time.sleep(45)",
].join("\n"));
const mcpScript = path.join(home, "echo.mjs");
await writeFile(mcpScript, [
  "import { createInterface } from 'node:readline';",
  "import { appendFileSync } from 'node:fs';",
  "const label = process.argv[2], log = process.argv[3];",
  "createInterface({input:process.stdin}).on('line', line => {",
  " const q=JSON.parse(line); if(q.id===undefined)return; let result={};",
  " if(q.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'isolation-echo',version:'1'}};",
  " if(q.method==='tools/list')result={tools:[{name:'echo',description:'Return this server identity',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]};",
  String.raw` if(q.method==='tools/call'){const text='MCP_RESULT='+label+' input='+q.params.arguments.text;appendFileSync(log,JSON.stringify({label,text,pid:process.pid})+'\n');result={content:[{type:'text',text}]};}`,
  String.raw` process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\n');`,
  "});",
].join("\n"));
const stages = new Map<string, number>();
const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
const normalized: unknown[] = [];
const shellCall = (command: string, index: number, codeMode: boolean): { name: string; arguments: JsonRecord } => {
  if (id === "kimi") { return { name: "Bash", arguments: { command } }; }
  if (id === "grok") { return { name: "run_terminal_command", arguments: { command, description: "Run the owned isolation probe", block_until_ms: 30_000 } }; }
  if (id === "opencode") { return codeMode ? { name: "shell", arguments: { command } } : { name: "bash", arguments: { command, description: "Run the owned isolation probe" } }; }
  return { name: "run_command", arguments: { CommandLine: command, Cwd: cwds[index], WaitMsBeforeAsync: 10_000, toolSummary: "Isolation probe", toolAction: "Checking isolation" } };
};
const mcpCall = (text: string, codeMode: boolean): { name: string; arguments: JsonRecord } => {
  if (id === "kimi") { return { name: "mcp__scope__echo", arguments: { text } }; }
  if (id === "opencode") { return codeMode ? { name: "execute", arguments: { code: `return await tools.scope.echo(${JSON.stringify({ text })});` } } : { name: "scope_echo", arguments: { text } }; }
  if (id === "grok") { return { name: "use_tool", arguments: { tool_name: "scope__echo", tool_input: { text } } }; }
  return { name: "call_mcp_tool", arguments: { ServerName: "scope", ToolName: "echo", Arguments: { text }, toolSummary: "Isolation probe", toolAction: "Checking isolation" } };
};
const provider = await factories[id]((mock) => {
  mock.on({ predicate: (request) => request.messages.some((message) => message.role === "user" && /PROBE_ACP_\d_\w+/u.test(JSON.stringify(message.content))) }, async (request) => {
    const user = request.messages.findLast((message) => message.role === "user" && /PROBE_ACP_\d_\w+/u.test(JSON.stringify(message.content)));
    const match = /PROBE_ACP_(?<index>\d)_(?<phase>\w+)/u.exec(JSON.stringify(user));
    const index = Number(match?.groups?.index); const phase = match?.groups?.phase ?? "unknown";
    const key = `${String(index)}_${phase}`; const stage = stages.get(key) ?? 0; stages.set(key, stage + 1);
    const codeMode = (request.tools ?? []).some((tool) => tool.function.name === "execute");
    normalized.push({ key, stage, request });
    if ((phase === "cwd" || phase === "cancel") && stage === 0) {
      const command = `python3 '${toolScript}' ${phase === "cwd" ? "cwd" : `sleep '${path.join(home, "tool-pids.json")}'`}`;
      const call = shellCall(command, index, codeMode);
      return { toolCalls: [{ id: `call-${key}`, name: call.name, arguments: JSON.stringify(call.arguments) }] };
    }
    if (phase === "mcp" && stage === 0) {
      const call = mcpCall(`SESSION_${String(index)}`, codeMode);
      return { toolCalls: [{ id: `call-${key}`, name: call.name, arguments: JSON.stringify(call.arguments) }] };
    }
    if (phase === "peer" || phase === "cancel") {
      const gate = Promise.withResolvers<void>(); gates.set(key, gate); await gate.promise;
    }
    return { content: `ANSWER_${key}` };
  });
  mock.onMessage(/[\s\S]*/u, { content: "metadata" });
});
const env = Object.fromEntries(Object.entries({ ...isolatedEnvironment(home), ...provider.env }).filter((entry): entry is [string, string] => entry[1] !== null));
const terminals = new Map<string, AcpTerminalHost>();
const terminalFor = (sessionId: string): AcpTerminalHost => { const terminal = terminals.get(sessionId); assert.ok(terminal !== undefined, "known session owns terminal requests"); return terminal; };
const routed: AcpTerminalHost = {
  create: async (params) => { const reply = await terminalFor(params.sessionId).create(params); return reply; },
  output: (params) => terminalFor(params.sessionId).output(params),
  waitForExit: async (params) => { const reply = await terminalFor(params.sessionId).waitForExit(params); return reply; },
  kill: (params) => terminalFor(params.sessionId).kill(params),
  release: async (params) => { const reply = await terminalFor(params.sessionId).release(params); return reply; },
  dispose: async () => { await Promise.all([...terminals.values()].map(async (terminal) => { await terminal.dispose(); })); },
};
const wire: unknown[] = []; const notifications: unknown[] = [];
const app = createAcpClientApp(routed, { update: (params) => { notifications.push({ at: performance.now(), params }); },
  requested: (requestId, method, params) => { wire.push({ at: performance.now(), requestId, method, params }); },
  answered: (requestId, reply) => { wire.push({ at: performance.now(), requestId, reply }); },
  extension: (method, params) => { notifications.push({ at: performance.now(), method, params }); }, extensionNotifications: profiles[id].extensionNotifications ?? [] });
const runtime = defaultRuntimes.require(id); const installation = await runtime.installation?.();
assert.ok(installation?.kind === "available" && installation.via === "executable");
const profile = profiles[id]; const options = { cwd: home };
const before = await processTable();
const child = startAcpProcess(installation.command, typeof profile.args === "function" ? profile.args(options) : profile.args, app, { cwd: home, env });
const request = async (method: string, params: JsonRecord): Promise<JsonRecord> => {
  const at = performance.now();
  try {
    const response = await withAcpDeadline(child, method, method === "session/prompt" ? 60_000 : 15_000,  async (opts) => { const reply = await child.connection.agent.request(method, params, opts); return reply; });
    wire.push({ method, params, response, at, endedAt: performance.now() }); return asRecord(response) ?? {};
  } catch (error) { wire.push({ method, params, error: String(error), at, endedAt: performance.now() }); throw error; }
};
const report: Record<string, unknown> = { id, version: installation.version, at: new Date().toISOString(), antigravityCwdIsExplicit: id === "antigravity" };
const observe = async (): Promise<LinuxProcess[]> => forest(await processTable(), await newRoots(before));
const known = new Map<number, LinuxProcess>();
const track = async (): Promise<LinuxProcess[]> => { const rows = await observe(); for (const row of rows) { known.set(row.pid, row); } return rows; };
async function until(predicate: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = performance.now() + ms;
  while (!await predicate()) { if (performance.now() >= end) { return false; } await delay(50); }
  return true;
}
const pending: Promise<unknown>[] = [];
try {
  const initialized = await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: {}, terminal: true }, clientInfo: { name: "oar-isolation-probe", version: "1" }, _meta: profile.initializeMeta?.(options) ?? {} });
  const auth = profile.selectAuthMethod?.(initialized); if (auth !== undefined) { await request("authenticate", { methodId: auth }); }
  const opened = await Promise.all(cwds.map(async (cwd, index) => {
    const response = await request("session/new", { cwd, mcpServers: [{ name: "scope", command: process.execPath, args: [mcpScript, `SERVER_${String(index)}`, path.join(home, "mcp-calls.jsonl")], env: [] }], _meta: profile.sessionMeta?.({ cwd }, initialized) ?? {} });
    assert.equal(typeof response.sessionId, "string"); const sessionId = String(response.sessionId);
    terminals.set(sessionId, createAcpTerminalHost(cwd, env, { shellCommand: id === "grok" }));
    await profile.configureSession?.({ request, sessionId, response, options: { cwd } }); return sessionId;
  }));
  report.opened = opened; assert.equal(new Set(opened).size, 2);
  const prompt = async (index: number, phase: string): Promise<JsonRecord> => { const reply = await request("session/prompt", { sessionId: opened[index], prompt: [{ type: "text", text: `PROBE_ACP_${String(index)}_${phase}` }] }); return reply; };
  report.cwdReplies = await Promise.all([prompt(0, "cwd"), prompt(1, "cwd")]);
  const toolOutput = (index: number, phase: string): string => normalized.filter((entry) => asRecord(entry)?.key === `${String(index)}_${phase}`)
    .flatMap((entry) => {
      const rawMessages = asRecord(asRecord(entry)?.request)?.messages;
      const messages: readonly unknown[] = Array.isArray(rawMessages) ? rawMessages : [];
      return messages.filter((message: unknown) => asRecord(message)?.role === "tool" && asRecord(message)?.tool_call_id === `call-${String(index)}_${phase}`);
    }).map((message: unknown) => JSON.stringify(asRecord(message)?.content)).join("\n");
  report.cwdIsolation = cwds.map((cwd, index) => ({ index, matched: toolOutput(index, "cwd").includes(`CWD_RESULT=${cwd}`) && !toolOutput(index, "cwd").includes(`CWD_RESULT=${cwds[1 - index] ?? ""}`) }));
  assert.ok(cwds.every((cwd, index) => toolOutput(index, "cwd").includes(`CWD_RESULT=${cwd}`)), "native tools ran in each session cwd");
  report.mcpReplies = await Promise.all([prompt(0, "mcp"), prompt(1, "mcp")]);
  report.mcpIsolation = [0, 1].map((index) => ({ index, matched: toolOutput(index, "mcp").includes(`MCP_RESULT=SERVER_${String(index)} input=SESSION_${String(index)}`) && !toolOutput(index, "mcp").includes(`MCP_RESULT=SERVER_${String(1 - index)}`) }));
  assert.ok([0, 1].every((index) => toolOutput(index, "mcp").includes(`MCP_RESULT=SERVER_${String(index)} input=SESSION_${String(index)}`)), "same-named MCP servers remain scoped to their sessions");
  const mcpText = await readFile(path.join(home, "mcp-calls.jsonl"), "utf8").catch(() => "");
  report.mcpCalls = mcpText.trim().split("\n").filter(Boolean).map((line): unknown => JSON.parse(line));
  const ends = new Map<number, unknown>();
  const observedPrompt = async (index: number, phase: string): Promise<void> => {
    try { const value = await prompt(index, phase); ends.set(index, { value, at: performance.now() }); }
    catch (error) { ends.set(index, { error: String(error), at: performance.now() }); }
  };
  const target = observedPrompt(0, "cancel"); const peer = observedPrompt(1, "peer");
  pending.push(target, peer);
  let markers: JsonRecord | null = null;
  const ready = await until(async () => { try { const markerText = await readFile(path.join(home, "tool-pids.json"), "utf8"); markers = asRecord(JSON.parse(markerText)); return markers !== null && gates.has("1_peer"); } catch { return false; } }, 20_000);
  report.ready = ready; report.markers = markers; assert.ok(ready, "target tool and peer provider are both active");
  const rows = await track(); const tools = rows.filter((row) => markers !== null && Object.values(markers).includes(row.pid)); report.toolsBefore = tools;
  assert.equal(tools.length, 2, "the owned command parent and child were observed before cancelling");
  const interruptedAt = performance.now(); await child.connection.agent.notify("session/cancel", { sessionId: opened[0] });
  const targetEnded = await until(() => ends.has(0), 10_000); report.targetEnded = targetEnded; report.targetEnd = ends.get(0) ?? null;
  report.cancelAt = interruptedAt; report.peerEndedBeforeRelease = ends.get(1) ?? null;
  await delay(Math.max(0, 2000 - (performance.now() - interruptedAt))); report.toolsAtTwoSeconds = await survivors(tools);
  gates.get("1_peer")?.resolve(); await peer; report.peerEnd = ends.get(1) ?? null;
  await delay(Math.max(0, 10_000 - (performance.now() - interruptedAt))); report.toolsAtTenSeconds = await survivors(tools);
  report.closeAt = performance.now(); report.close = await request("session/close", { sessionId: opened[0] }).then((value) => ({ value }), (error: unknown) => ({ error: String(error) }));
  if (disposeTargetTerminals) { await terminalFor(opened[0] ?? "").dispose(); report.hostDisposedTargetTerminals = true; }
  await delay(2000); report.toolsAfterClose = await survivors(tools); report.peerAfterClose = await prompt(1, "afterclose");
  const observations: unknown[] = [];
  await until(async () => { const alive = await survivors(tools); observations.push({ atMs: performance.now() - interruptedAt, alive }); return alive.length === 0; }, 40_000);
  report.observations = observations; report.outcome = "completed";
} catch (error) { report.outcome = "failed"; report.error = String(error); }
finally {
  await track(); for (const gate of gates.values()) { gate.resolve(); }
  child.kill(); await child.exited; await routed.dispose(); await Promise.allSettled(pending); await delay(1000);
  report.cleanupSurvivors = await survivors([...known.values()]); report.wire = wire; report.notifications = notifications; report.normalized = normalized; report.providerRequests = provider.raw;
  await writeFile(path.join(out, "evidence.json"), `${JSON.stringify(report, null, 2)}\n`); await provider.stop();
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
process.stdout.write(`${JSON.stringify({ id, outcome: report.outcome, error: report.error })}\n`);
assert.equal(report.outcome, "completed");
