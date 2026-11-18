/* oxlint-disable unicorn/no-useless-undefined -- Explicit empty capture state satisfies init-declarations. */
/* oxlint-disable eslint/no-await-in-loop -- The native experiment measures ordered state transitions and queries. */
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { writeFile, cp, mkdir } from "node:fs/promises";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { startAntigravityAimock } from "../../sea-trial/harness/aimock-acp.js";
import { createAcpClient, methods, startAcpProcess, withAcpDeadline } from "../../packages/oar/src/shared/acp/process.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";

const [binary, version, mode, output] = process.argv.slice(2);
assert.ok(binary !== undefined && version !== undefined && mode !== undefined && output !== undefined);
const began = performance.now(), epoch = Date.now();
const wire: unknown[] = [];
const queries: unknown[] = [];
const provider: unknown[] = [];
const mark = (kind: string, value: unknown): { atMs: number; kind: string; value: unknown } => ({ atMs: performance.now() - began, kind, value });
const commandSeconds = Number(process.env.TASK298_COMMAND_SECONDS ?? 4);
const firstReadDelayMs = Number(process.env.TASK298_FIRST_READ_MS ?? 0);
const reads: unknown[] = [];
let adoptedAtMs: number | undefined = undefined;
let promptEnded = false;
let sid: string | undefined = undefined;
const state: { reader?: DatabaseSync; secondCommand: boolean } = { secondCommand: false };
let timer: ReturnType<typeof setInterval> | undefined = undefined;
let firstReadTimer: ReturnType<typeof setTimeout> | undefined = undefined;
const readSummary = (reason: string): void => {
  const at = performance.now();
  try {
    assert.ok(home !== undefined && sid !== undefined);
    state.reader ??= new DatabaseSync(join(home, ".gemini", "antigravity-cli", "conversation_summaries.db"), { readOnly: true });
    state.reader.exec("PRAGMA query_only = ON");
    const row = state.reader.prepare("SELECT conversation_id, status, not_fully_idle, step_count, last_modified_time FROM conversation_summaries WHERE conversation_id = ?").get(sid);
    reads.push(mark(reason, { row: row ?? null, elapsedMs: performance.now() - at }));
  } catch (error) { reads.push(mark(reason, { error: String(error), elapsedMs: performance.now() - at })); }
};
const startReads = (): void => { readSummary("first"); timer = setInterval(() => { readSummary("poll"); }, 250); };
let calls = 0;
const fixture = await startAntigravityAimock(mock => {
  mock.on({ predicate: () => true }, async request => {
    if (JSON.stringify(request.messages).includes("conversation title generator")) { return { content: "Background native signal" }; }
    calls++;
    provider.push(mark("request", { call: calls, messages: request.messages }));
    if (calls === 1) { return { toolCalls: [{ name: "run_command", arguments: JSON.stringify({ CommandLine: `sleep ${commandSeconds}; echo FINISHED`, WaitMsBeforeAsync: 500, toolSummary: "Background completion control" }) }] }; }
    if (calls === 2) { return { content: "STARTED" }; }
    if (calls === 3 && mode === "cancel") { return { toolCalls: [{ name: "run_command", arguments: JSON.stringify({ CommandLine: "sleep 20; echo SHOULD_NOT_FINISH", WaitMsBeforeAsync: 10_000, toolSummary: "Unprompted cancellation control" }) }] }; }
    if (calls === 3 && mode === "slow") { await delay(4000); }
    return { content: "FOLLOWUP_FINISHED" };
  });
});
const home = fixture.env.HOME;
assert.ok(home !== undefined);
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "LANG", "LC_ALL", "TMPDIR", "SystemRoot"].includes(key)));
const native = startAcpProcess(resolve(binary), ["acp", "--disable-telemetry", "--dangerously-skip-permissions", "--process-per-session"], createAcpClient({ name: "native-active-turn-probe" }).onNotification(methods.client.session.update, () => {}), {
  cwd: home, env: { ...inherited, ...fixture.env },
  outgoing: message => { wire.push(mark("client", message)); },
  incoming: message => {
    wire.push(mark("agent", message));
    const update = asRecord(asRecord(asRecord(message)?.params)?.update);
    if (promptEnded && adoptedAtMs === undefined && ["tool_call", "tool_call_update", "agent_message_chunk", "agent_thought_chunk"].includes(String(update?.sessionUpdate))) {
      adoptedAtMs = performance.now() - began;
      if (firstReadDelayMs > 0) { firstReadTimer = setTimeout(startReads, firstReadDelayMs); }
      else { startReads(); }
    }
    if (JSON.stringify(message).includes("SHOULD_NOT_FINISH") && asRecord(asRecord(message)?.params)?.update !== undefined) { state.secondCommand = true; }
    return message;
  },
});
const request = async (method: string, params: JsonRecord): Promise<JsonRecord> => {
  try {
    const value = await withAcpDeadline(native, method, 10_000, async options => { const response = await native.connection.agent.request(method, params, options); return response; });
    queries.push(mark(method, value));
    return asRecord(value) ?? {};
  } catch (error) { queries.push(mark(method, { error: String(error) })); return {}; }
};
const dbStop = join(home, "observer.stop");
const dbChunks: Buffer[] = [];
let observer: ReturnType<typeof spawn> | undefined = undefined;
let dbExit: Promise<unknown> | undefined = undefined;
if (process.env.TASK298_DATABASE === "1") {
  observer = spawn("python3", ["experiments/antigravity-native-gaps-2026-11-15/observe-db.py", home, dbStop], { stdio: ["ignore", "pipe", "inherit"] });
  observer.stdout?.on("data", (data: Buffer) => { dbChunks.push(data); });
  dbExit = once(observer, "exit");
}
let failure: string | undefined = undefined;
try {
  await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "oar-probe", version: "0.0.0" } });
  const opened = await request("session/new", { cwd: home, mcpServers: [] });
  const { sessionId } = opened; assert.equal(typeof sessionId, "string");
  sid = String(sessionId);
  await request("session/set_config_option", { sessionId, configId: "model", value: "gemini-3.8-flash" });
  await request("session/prompt", { sessionId, prompt: [{ type: "text", text: "NATIVE_ACTIVE_BACKGROUND" }] });
  promptEnded = true;
  if (mode === "cancel") {
    const end = performance.now() + 12_000;
    while (!state.secondCommand && performance.now() < end) { await delay(20); }
    assert.ok(state.secondCommand, "unprompted tool call observed before cancellation");
    await native.connection.agent.notify("session/cancel", { sessionId });
    queries.push(mark("cancel_sent", null));
    await delay(2500);
    await request("session/prompt", { sessionId, prompt: [{ type: "text", text: "POST_CANCEL_HEALTH" }] });
    await delay(1500);
  } else {
    await delay(mode === "slow" ? 11_000 : 7000);
  }
  if (mode === "late-cancel") {
    await native.connection.agent.notify("session/cancel", { sessionId });
    queries.push(mark("late_cancel_sent", null));
    await delay(2500);
    queries.push(mark("health_prompt_start", null));
    await request("session/prompt", { sessionId, prompt: [{ type: "text", text: "POST_CANCEL_HEALTH" }] });
    await delay(1500);
  }
  if (mode === "queries") {
    for (const method of ["session/list", "session/state", "session/resume"]) { await request(method, { sessionId, cwd: home }); }
    await request("session/load", { sessionId, cwd: home, mcpServers: [] });
    await delay(500);
  }
} catch (error) { failure = String(error); process.exitCode = 1; }
finally {
  clearInterval(timer); clearTimeout(firstReadTimer); state.reader?.close();
  await writeFile(dbStop, "stop");
  await dbExit;
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "capture.json"), JSON.stringify({ version, mode, commandSeconds, firstReadDelayMs, adoptedAtMs, reads, epoch, home, wire, queries, provider, error: failure }, null, 2));
  await writeFile(join(output, "database.ndjson"), Buffer.concat(dbChunks));
  if (observer !== undefined) {
    const before = performance.now();
    const db = new DatabaseSync(join(home, ".gemini", "antigravity-cli", "conversation_summaries.db"), { readOnly: true });
    db.exec("PRAGMA query_only = ON");
    const query = db.prepare("SELECT conversation_id, status, not_fully_idle, step_count, last_modified_time FROM conversation_summaries WHERE conversation_id = ?");
    assert.ok(sid !== undefined);
    const initial = query.get(sid);
    const firstMs = performance.now() - before;
    const samples: number[] = [];
    for (let i = 0; i < 1000; i++) { const at = performance.now(); query.get(sid); samples.push(performance.now()-at); }
    db.close(); samples.sort((a,b) => a-b);
    await writeFile(join(output, "read-cost.json"), JSON.stringify({ firstMs, medianMs: samples[500], maxMs: samples.at(-1), count: samples.length, initial }, null, 2));
  }
  if (observer !== undefined) { await cp(join(home, ".gemini", "antigravity-cli", "conversations"), join(output, "databases"), { recursive: true }); }
  native.kill(); await native.exited;
  await fixture.stop();
}
console.log(JSON.stringify({ version, mode, calls, frames: wire.length, error: failure, output }));
