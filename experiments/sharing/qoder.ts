/** Qoder >=1.1.81 native shared daemon gates; no real account or model traffic. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { qoderFixture } from "./qoder-fixture.js";
import { until } from "./codex-fixture.js";
import { identities, running } from "./processes.js";

const fixture = await qoderFixture();
const out = path.resolve(process.argv[2] ?? "oar-trial-run/qoder-sharing"); await mkdir(out, { recursive: true });
const report: JsonRecord = { at: new Date().toISOString(), platform: process.platform, installation: fixture.installation };
const observe = async (name: string, work: () => Promise<unknown>): Promise<void> => {
  try { report[name] = { observed: true, value: await work() }; } catch (error) { report[name] = { observed: false, error: String(error) }; }
  process.stdout.write(`${name}: ${JSON.stringify(report[name])}\n`);
};
const quote = (value: string): string => process.platform === "win32" ? `"${value.replaceAll('"', String.raw`\"`)}"` : `'${value.replaceAll("'", String.raw`'\''`)}'`;
try {
  const connection = await fixture.connect();
  const dirs = [path.join(fixture.home, "a"), path.join(fixture.home, "b")]; await Promise.all(dirs.map(async (cwd) => { await mkdir(cwd); }));
  const script = path.join(fixture.home, "command.cjs");
  await writeFile(script, "const {spawn}=require('node:child_process'),{writeFileSync}=require('node:fs');if(process.argv[2]==='cwd')console.log('CWD_RESULT='+process.cwd());else{const c=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});writeFileSync(process.argv[3],JSON.stringify({parent:process.pid,child:c.pid}));console.log('READY');setTimeout(()=>{},60000)}");
  const mcp = path.join(fixture.home, "mcp.cjs");
  await writeFile(mcp, String.raw`require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;let result={};if(q.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'scope',version:'1'}};if(q.method==='tools/list')result={tools:[{name:'echo',description:'Return marker',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]};if(q.method==='tools/call')result={content:[{type:'text',text:'MCP_RESULT='+process.argv[2]+' input='+q.params.arguments.text}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\n');});`);
  const sessions = await Promise.all(dirs.map(async (cwd, index) => {
    const label = index === 0 ? "A" : "B"; const config = path.join(fixture.home, `${label}-mcp.json`);
    await writeFile(config, JSON.stringify({ mcpServers: { scope: { type: "stdio", command: process.execPath, args: [mcp, label] } } }));
    const session = await fixture.open(connection, { cwd, replies: [
      { tool: { name: "Bash", args: { command: [process.execPath, script, "cwd"].map((arg) => quote(arg)).join(" ") } } }, { text: `ANSWER_${label}_cwd` },
      { tool: { name: "mcp__scope__echo", args: { text: label } } }, { text: `ANSWER_${label}_mcp` }, { text: `ANSWER_${label}_resume` },
    ], extra: ["--mcp-config", config] });
    return { ...session, label, cwd };
  }));
  const [a, b] = sessions; assert.ok(a && b && a.id !== b.id); report.sessions = sessions.map(({ id, cwd, label }) => ({ id, cwd, label }));
  await observe("cwdAndMessageIsolation", async () => {
    const results = await Promise.all(sessions.map(async (session) => { const result = await fixture.turn(connection, session.id); return result; }));
    sessions.forEach((session, index) => { assert.equal(results[index]?.result, `ANSWER_${session.label}_cwd`); assert.equal(results[index].session_id, session.id);
      assert.ok(JSON.stringify(fixture.frames.filter((frame) => frame.session_id === session.id)).includes(JSON.stringify(`CWD_RESULT=${session.cwd}`).slice(1, -1))); });
    return { results };
  });
  await observe("mcpIsolation", async () => {
    const results = await Promise.all(sessions.map(async (session) => { const result = await fixture.turn(connection, session.id); return result; }));
    sessions.forEach((session, index) => { assert.equal(results[index]?.result, `ANSWER_${session.label}_mcp`);
      assert.ok(JSON.stringify(fixture.frames.filter((frame) => frame.session_id === session.id)).includes(`MCP_RESULT=${session.label} input=${session.label}`)); });
    return { results };
  });
  await observe("loadedResume", async () => {
    const result = await fixture.open(connection, { cwd: a.cwd, replies: [{ text: "RESUMED" }], resume: a.id }).then((value) => ({ accepted: true, id: value.id }), (error: unknown) => ({ accepted: false, error: String(error) }));
    const peer = await fixture.turn(connection, b.id); return { result, peer };
  });
  await observe("closeResumeRace", async () => {
    const results = await Promise.allSettled([a.control.request({ type: "daemon.close_session" }), fixture.open(connection, { cwd: a.cwd, replies: [{ text: "RACED" }], resume: a.id })]);
    const resumed = await fixture.open(connection, { cwd: a.cwd, replies: [{ text: "RACE_CONFIRMED" }], resume: a.id });
    const confirmed = await fixture.turn(connection, resumed.id); assert.equal(confirmed.result, "RACE_CONFIRMED");
    return { resumedId: resumed.id, confirmed, results: results.map((entry) => entry.status === "fulfilled" ? { status: entry.status } : { status: entry.status, error: String(entry.reason) }) };
  });
  await observe("scopedCleanup", async () => {
    const workers = await Promise.all(dirs.map(async (cwd, index) => {
      const marker = path.join(fixture.home, `${String(index)}.json`);
      const worker = await fixture.open(connection, { cwd, replies: [{ tool: { name: "Bash", args: { command: [process.execPath, script, "tool", marker].map((arg) => quote(arg)).join(" ") } } }, { text: "TOOL_DONE" }] });
      return { ...worker, marker };
    }));
    const [target, peer] = workers; assert.ok(target && peer);
    const ends: unknown[] = []; const turns = workers.map(async (worker) => { try { ends.push({ id: worker.id, value: await fixture.turn(connection, worker.id) }); } catch (error) { ends.push({ id: worker.id, error: String(error) }); } });
    const markers = await Promise.all(workers.map(async (worker) => {
      await until(async () => { try { await readFile(worker.marker); return true; } catch { return false; } }, "owned command starts");
      const marker = asRecord(JSON.parse(await readFile(worker.marker, "utf8"))); assert.ok(marker); return identities([Number(marker.parent), Number(marker.child)]);
    }));
    const interrupted = await target.control.request({ subtype: "interrupt" }); await delay(1000);
    const afterCancel = markers.map((entries) => running(entries)); const targetClosed = await target.control.request({ type: "daemon.close_session" }); await delay(1000);
    const afterClose = markers.map((entries) => running(entries)); const endsBeforePeerClose = [...ends];
    await peer.control.request({ type: "daemon.close_session" });
    // Native close need not emit a result; release probe observers explicitly.
    for (const worker of workers) { connection.turns.get(worker.id)?.reject(new Error("Probe observer released after native close")); }
    await Promise.all(turns); return { interrupted, targetClosed, afterCancel, afterClose, endsBeforePeerClose };
  });
  await observe("childAttribution", async () => {
    const offset = fixture.frames.length;
    const worker = await fixture.open(connection, { cwd: a.cwd, replies: [
      { tool: { name: "Agent", args: { prompt: "Return CHILD_MARKER", description: "Check child routing", subagent_type: "general-purpose" } } },
      { text: "CHILD_OR_PARENT_MARKER" }, { text: "PARENT_END" },
    ] });
    const peer = await fixture.open(connection, { cwd: b.cwd, replies: [{ text: "CHILD_PEER" }] });
    const [result, peerResult] = await Promise.all([fixture.turn(connection, worker.id), fixture.turn(connection, peer.id)]);
    assert.equal(peerResult.result, "CHILD_PEER");
    const frames = fixture.frames.slice(offset);
    const children = frames.filter((frame) => typeof frame.parent_tool_use_id === "string");
    const childLifecycle = frames.filter((frame) => frame.type === "system" && /task|agent/u.test(String(frame.subtype)));
    assert.ok(children.length > 0 && children.every((frame) => frame.session_id === worker.id));
    assert.ok(childLifecycle.some((frame) => frame.subtype === "task_started" && children.some((entry) => entry.parent_tool_use_id === frame.tool_use_id)));
    return { rootId: worker.id, peerId: peer.id, result, peerResult, nestedFrames: children, childLifecycle };
  });
  await observe("exitWithActiveSessions", async () => {
    const workers = await Promise.all(dirs.map(async (cwd) => { const worker = await fixture.open(connection, { cwd, replies: [{ chunks: Array.from({ length: 500 }, () => "held ") }] }); return worker; }));
    const offset = fixture.frames.length; const ends: unknown[] = [];
    const turns = workers.map(async (worker) => { try { ends.push({ id: worker.id, value: await fixture.turn(connection, worker.id) }); } catch (error) { ends.push({ id: worker.id, error: String(error) }); } });
    await until(() => workers.every((worker) => fixture.frames.slice(offset).some((frame) => frame.session_id === worker.id && frame.type === "stream_event")), "both streams started");
    const endedBeforeExit = ends.length; fixture.crash(connection); const exit = await connection.child.exited; await Promise.all(turns);
    return { endedBeforeExit, exit, ends };
  });
} finally {
  report.frames = fixture.frames;
  await writeFile(path.join(out, "evidence.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); await fixture.stop();
}
assert.ok(Object.values(report).every((value) => asRecord(value)?.observed !== false), "inspect evidence.json for failed observations");
