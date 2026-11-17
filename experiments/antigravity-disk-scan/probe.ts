/* oxlint-disable import/max-dependencies, max-statements, max-lines-per-function, typescript/promise-function-async -- Independent native/provider/process observations in one bounded experiment. */
/* oxlint-disable no-await-in-loop, no-continue -- Ordered polling and process observations, skipping exited or reused identities. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startAntigravityAimock } from "../../sea-trial/harness/aimock-acp.js";
import { antigravityRuntime, type Session, type RawEvent } from "../../packages/oar/src/index.js";
import { statusOf } from "../../packages/oar/src/observe/agent-status.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";

const [binary, mode, output] = process.argv.slice(2);
assert.ok(binary !== undefined && mode !== undefined && output !== undefined && ["complete", "idle-abort", "active-abort", "foreground-abort", "dispose"].includes(mode));
assert.equal(process.platform, "linux", "The slow-directory observer is Linux-only");
const version = execFileSync(path.resolve(binary), ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
assert.equal(version, "1.5.9", "Reassess the observations before testing another native version");
const started = Date.now();
const ticks: unknown[] = [];
const provider: unknown[] = [];
const mark = (kind: string, value: unknown): void => { ticks.push({ atMs: Date.now() - started, kind, value }); };
const hold = Promise.withResolvers<void>();
let calls = 0;
let command = "";
let secondRequest = false;
const fixture = await startAntigravityAimock(mock => {
  mock.on({ predicate: () => true }, async request => {
    const text = JSON.stringify(request.messages);
    if (text.includes("conversation title generator")) { return { content: "Disk scan fixture" }; }
    calls += 1; provider.push({ atMs: Date.now() - started, call: calls, messages: request.messages });
    if (calls === 1) { return { toolCalls: [{ name: "run_command", arguments: JSON.stringify({ CommandLine: command, WaitMsBeforeAsync: mode === "foreground-abort" ? 30_000 : 500, toolSummary: "Read-only scan of synthetic home" }) }] }; }
    if (calls === 2) { secondRequest = true; if (mode === "active-abort") { await hold.promise; } }
    return { content: text.includes("LATER_PROMPT") ? "LATER_ACCEPTED" : "ROOT_OR_BACKGROUND_REPLY" };
  });
});
const home = fixture.env.HOME; assert.ok(home !== undefined);
const scan = path.join(home, "scan");
await mkdir(scan);
await Promise.all(Array.from({ length: 5 }, async (_, directory) => {
  const folder = path.join(scan, directory === 0 ? ".hidden" : `dir${directory}`);
  await mkdir(folder);
  await Promise.all(Array.from({ length: 30 }, async (_file, file) => { await writeFile(path.join(folder, `file${file}`), "synthetic file\n"); }));
}));
const trace = path.join(home, "du-pids.txt");
const rootTrace = path.join(home, "native-pid.txt");
const wrapper = path.join(home, "agy-observed");
const library = path.join(home, "slow-directory.so");
execFileSync("gcc", ["-shared", "-fPIC", "-o", library, fileURLToPath(new URL("slow-directory.c", import.meta.url)), "-ldl"]);
const quote = (s: string): string => `'${s.replaceAll("'", String.raw`'\''`)}'`;
await writeFile(wrapper, `#!/bin/sh\nprintf '%s\\n' "$$" > ${quote(rootTrace)}\nexec ${quote(path.resolve(binary))} "$@"\n`);
await chmod(wrapper, 0o700);
command = `df -h ${quote(scan)}; LD_PRELOAD=${quote(library)} OAR_DU_TRACE=${quote(trace)} du -sh ${quote(scan)}/* ${quote(scan)}/.[!.]* 2>/dev/null | sort -hr | head -n 25`;
let session: Session | null = null;
let idleRecords: readonly RawEvent[] = [];
const known = new Map<number, { start: string; pgid: number; name: string }>();
async function sample(label: string): Promise<{ pid: number; state: string; start: string; pgid: number; ppid: number; name: string }[]> {
  let pids: string[] = [];
  try { const value = await readFile(trace, "utf8"); pids = value.trim().split("\n"); } catch { /* No du has started. */ }
  try { const value = await readFile(rootTrace, "utf8"); pids.push(value.trim()); } catch { /* Native has not started. */ }
  const rows: { pid: number; state: string; start: string; pgid: number; ppid: number; name: string }[] = [];
  for (const raw of pids) {
    const pid = Number(raw); if (!Number.isSafeInteger(pid) || pid <= 1) { continue; }
    try {
      const stat = await readFile(`/proc/${String(pid)}/stat`, "utf8");
      const end = stat.lastIndexOf(")"); const fields = stat.slice(end + 2).split(" ");
      const row = { pid, name: stat.slice(stat.indexOf("(") + 1, end), state: fields[0] ?? "", pgid: Number(fields[2]), ppid: Number(fields[1]), start: fields[19] ?? "" };
      const previous = known.get(pid);
      if (previous !== undefined && previous.start !== row.start) { continue; }
      known.set(pid, row); rows.push(row);
    } catch { /* Process exited. */ }
  }
  mark(label, { processes: rows, status: session?.status() });
  return rows.filter(row => row.name === "du");
}
async function until(check: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) { return true; } await delay(100); }
  return false;
}
async function groupMembers(): Promise<{ pid: number; start: string; state: string; pgid: number; ppid: number; name: string }[]> {
  const groups = new Set([...known.values()].map(row => row.pgid));
  const rows: { pid: number; start: string; state: string; pgid: number; ppid: number; name: string }[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/u.test(entry)) { continue; }
    try {
      const stat = await readFile(`/proc/${entry}/stat`, "utf8"); const end = stat.lastIndexOf(")"); const fields = stat.slice(end + 2).split(" ");
      if (groups.has(Number(fields[2]))) { rows.push({ pid: Number(entry), name: stat.slice(stat.indexOf("(") + 1, end), state: fields[0] ?? "", pgid: Number(fields[2]), ppid: Number(fields[1]), start: fields[19] ?? "" }); }
    } catch { /* Process exited. */ }
  }
  return rows;
}
let failure: string | null = null;
let records: unknown = null;
let timer: NodeJS.Timeout | null = null;
try {
  session = await antigravityRuntime.session({ kind: "available", via: "executable", command: wrapper, version: "1.5.9" }, { cwd: home, env: fixture.env, model: "gemini-3.8-flash" });
  session.rawEvents(record => { mark("record", record); });
  const current = session;
  timer = setTimeout(() => { failure = "120-second experiment bound reached"; mark("deadline", failure); hold.resolve(); void current.dispose(); }, 120_000);
  mark("command", command);
  const prompt = await session.prompt("帮我扫描一下硬盘，我想清理垃圾。只统计给定的测试目录，不要删除任何内容。");
  const ending = awaitTurnEnd(current, prompt.request.seq);
  assert.ok(await until(async () => { const rows = await sample("waiting-du"); return rows.length > 0; }, 15_000), "du must actually start");
  if (mode === "active-abort") { assert.ok(await until(() => secondRequest, 10_000)); }
  if (mode === "foreground-abort" || mode === "active-abort") {
    mark("abort", await session.abort());
    mark("turn-result", await ending);
    hold.resolve();
    await sample("after-abort"); await delay(2000); await sample("two-seconds-after-abort");
  } else {
    mark("turn-result", await ending);
    await sample("after-initial-end");
    assert.equal(session.status().value.kind, "idle");
    idleRecords = [...session.records()];
    if (mode === "idle-abort") { mark("abort-after-end", await session.abort()); await sample("after-idle-abort"); }
    if (mode === "complete") {
      assert.ok(await until(async () => { const rows = await sample("waiting-scan-end"); return rows.length === 0; }, 30_000), "du should naturally finish");
      await delay(2500); await sample("after-natural-completion");
    }
  }
  if (mode !== "dispose") {
    try {
      const later = await session.prompt("LATER_PROMPT"); mark("later-submission", later);
      if (later.response.body.kind === "accepted") { mark("later-result", await awaitTurnEnd(session, later.request.seq)); }
    } catch (error) { mark("later-error", String(error)); }
  }
  if (mode === "complete") {
    const all = session.records();
    const laterEnd = all.find(record => record.kind === "frame" && record.seq > (idleRecords.at(-1)?.seq ?? 0) && record.body.events.some(event => event.kind === "tool_call_ended"));
    assert.ok(laterEnd !== undefined, "Next prompt must surface the captured late completion");
    const live = statusOf(all.filter(record => record.seq <= laterEnd.seq), session.id);
    assert.equal(live.value.kind, "running", "The next prompt is already accepted when completion arrives");
    const replay = statusOf([...idleRecords, laterEnd], session.id);
    assert.equal(replay.value.kind, "idle", "Replaying only late tool completion must not reopen an idle turn");
    mark("late-tool-status", { live, replay, replayOmitsNextPrompt: true });
    assert.equal(session.status().value.kind, "idle");
  }
  const hostedTerminals = session.records().filter(record => record.kind === "request" && record.direction === "toApp" && record.body.kind === "native" && record.body.type.startsWith("terminal/"));
  mark("hosted-terminal-requests", hostedTerminals);
  assert.equal(hostedTerminals.length, 0, "Native scan must not use OAR-hosted ACP terminals");
  await sample("before-dispose"); mark("groups-before-dispose", await groupMembers());
} catch (error) { failure = String(error); }
finally {
  if (timer !== null) { clearTimeout(timer); } hold.resolve();
  await session?.dispose(); mark("dispose-returned", session?.status());
  await sample("after-dispose"); mark("groups-after-dispose", await groupMembers());
  records = session?.records();
  await sample("final-survivors");
  // Last-resort cleanup only of exact identities in the fixture's observed groups.
  const survivors = await groupMembers();
  if (survivors.length > 0) { failure ??= "Observed fixture processes survived dispose"; }
  for (const row of survivors) {
    try {
      const stat = await readFile(`/proc/${String(row.pid)}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[19] === row.start && Number(fields[2]) === row.pgid) {
        process.kill(row.pid, "SIGKILL"); mark("emergency-kill", { pid: row.pid });
      }
    } catch { /* Already gone. */ }
  }
  if (survivors.length > 0) { await delay(500); mark("after-emergency-cleanup", await groupMembers()); }
  await writeFile(path.resolve(output), JSON.stringify({ mode, version, platform: process.platform, base: "bcaf599b", started, fixtureHome: home, error: failure, calls, ticks, records, provider }, null, 2));
  await fixture.stop();
}
console.log(JSON.stringify({ mode, error: failure, calls, output }));

if (failure !== null) { process.exitCode = 1; }
