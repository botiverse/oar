/* oxlint-disable eslint/no-await-in-loop -- Each sample must observe the preceding native turn, then dispose it before the next round. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { codexInstallation, codexSession, promptAndWait, type Session } from "../../packages/oar/src/index.js";
import { startCodexAimock } from "../../sea-trial/harness/aimock.js";
import { ECHO_SERVER } from "../../sea-trial/vendor/support/echo-mcp.js";

const [destination] = process.argv.slice(2);
const cleanHome = process.argv.includes("--clean-home");
const legacyFirst = process.argv.includes("--legacy-first");
const slowShell = process.argv.includes("--slow-shell");
const rounds = slowShell ? 2 : 12;
assert.ok(destination !== undefined && destination.length > 0, "provide a new private output directory");
await mkdir(destination, { recursive: false, mode: 0o700 });
const installation = await codexInstallation();
assert.ok(installation.kind === "available");
assert.notEqual(process.platform, "win32", "this probe requires POSIX ps and bash");
await writeFile(path.join(destination, "identity.json"), JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, codex: installation.via === "executable" ? installation.version : null, cleanHome, legacyFirst, slowShell, rounds }, null, 2));
function matching(marker: string): string[] {
  return execFileSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,lstart=,args="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).split("\n").filter(line => line.includes(marker));
}
function killMatching(marker: string): void {
  for (const line of matching(marker)) {
    const pid = Number(/^\s*(?<pid>\d+)/u.exec(line)?.groups?.pid);
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, "SIGKILL"); } catch { /* Gone meanwhile. */ }
    }
  }
}
async function starts(file: string): Promise<string | null> {
  try { return await readFile(file, "utf8"); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") { return null; } throw error; }
}
const summary = [];
for (let round = 0; round < rounds; round += 1) {
  const marker = `oar-earlier-probe-${randomUUID()}`;
  const directory = await mkdtemp(path.join(tmpdir(), "oar-codex-count-"));
  const home = path.join(directory, "home");
  await mkdir(home);
  const script = path.join(directory, "older.cjs");
  const trigger = path.join(directory, "fork-now");
  await writeFile(script, `
const { spawn } = require("node:child_process");
const { existsSync, appendFileSync } = require("node:fs");
const [, , trigger, marker, server] = process.argv;
appendFileSync(trigger + "." + marker + ".started", String(process.pid) + "\\n");
const run = (detached, name) => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", name], { detached, stdio: "ignore" }).unref();
const poll = setInterval(() => {
  if (existsSync(trigger)) {
    clearInterval(poll);
    run(false, marker.replace(/^oar-(\\w+)-/u, "oar-$1-worker-"));
    run(true, marker.replace(/^oar-(\\w+)-/u, "oar-$1-detached-"));
  }
}, 50);
if (server === undefined) { setInterval(() => {}, 1000); } else { import(server); }
`);
  const command = `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} ${JSON.stringify(trigger)} ${marker}`;
  const scriptedCommand = slowShell ? `(sleep 3; :) & (sleep 3; :) & (sleep 3; :) & wait; ${command}` : command;
  const provider = await startCodexAimock(mock => {
    mock.on({ userMessage: /START_EARLIER/u, hasToolResult: false }, { toolCalls: [{ id: "call-earlier", name: "exec_command", arguments: JSON.stringify({ cmd: scriptedCommand, yield_time_ms: 250 }) }] });
    mock.on({ userMessage: /START_EARLIER/u, hasToolResult: true }, { content: "earlier command left running" });
  });
  let session: Session | null = null;
  try {
    session = await codexSession(installation, { cwd: process.cwd(), env: { ...provider.env, ...(cleanHome ? { HOME: home } : {}) }, mcpServers: [{ name: "probe", command: process.execPath, args: [script, trigger, marker.replace("oar-earlier-", "oar-mcp-"), ECHO_SERVER] }], endTurnProcessesOnAbort: round % 2 === 0 });
    const result = await promptAndWait(session, "START_EARLIER", { timeoutMs: 30_000 });
    const legacyRows = legacyFirst ? execFileSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8" }).split("\n").filter(line => line.includes(marker)) : undefined;
    const atEnd = { at: new Date().toISOString(), rows: matching(marker) };
    const samples = [atEnd];
    for (let i = 0; i < 5; i += 1) { await delay(50); samples.push({ at: new Date().toISOString(), rows: matching(marker) }); }
    if (slowShell) { await delay(3500); samples.push({ at: new Date().toISOString(), rows: matching(marker) }); }
    const launches = await starts(`${trigger}.${marker}.started`);
    await writeFile(path.join(destination, `round-${round}.json`), JSON.stringify({ marker, result, samples, legacyRows, launches, records: session.records(), requests: provider.mock.getRequests().map(({ body, response }) => ({ body, response })) }, null, 2));
    const row = { round, legacyCount: legacyRows?.length, launches: launches?.trim().split("\n") ?? [], counts: samples.map(s => s.rows.length), result: result.kind };
    summary.push(row);
    console.log(JSON.stringify(row));
  } finally {
    try { await session?.dispose(); }
    finally {
      try { killMatching(marker); }
      finally { await provider.stop(); await rm(directory, { recursive: true, force: true }); }
    }
  }
}
await writeFile(path.join(destination, "summary.json"), JSON.stringify(summary, null, 2));
