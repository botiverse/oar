/* oxlint-disable import/max-dependencies, typescript/promise-function-async, promise/avoid-new, unicorn/no-useless-undefined -- A standalone native measurement retains the provider and ACP views together. */
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startAntigravityAimock } from "../../sea-trial/harness/aimock-acp.js";
import { promptAndWait, type Session, antigravityRuntime } from "../../packages/oar/src/index.js";

import { asRecord } from "../../packages/oar/src/shared/json.js";
import { ECHO_SERVER } from "../../sea-trial/vendor/support/echo-mcp.js";

const antigravitySession = antigravityRuntime.session;

const [binary, mode, output, seconds = "120"] = process.argv.slice(2);
assert.ok(binary !== undefined && mode !== undefined && output !== undefined);
const limitMs = Number(seconds) * 1000;
const startedEpochMs = Date.now();
const started = performance.now();
const ticks: unknown[] = [];
const provider: unknown[] = [];
const mark = (kind: string, body: unknown): void => { ticks.push({ atMs: performance.now() - started, kind, body }); };
const faults = new Set(["cut", "stall", "deadline", "401", "quota", "rate"]);
let mainRequests = 0;
const fixture = await startAntigravityAimock(mock => {
  mock.on({ predicate: () => true }, request => {
    const text = JSON.stringify(request.messages);
    if (text.includes("conversation title generator")) { return { content: "Native gaps probe" }; }
    mainRequests += 1;
    if (mainRequests > 1) { return { content: "NATIVE_GAPS_FOLLOWUP" }; }
    if (mode === "question") { return { toolCalls: [{ name: "ask_question", arguments: JSON.stringify({ questions: [{ question: "Which synthetic colour?", options: ["Synthetic red", "Synthetic blue"] }] }) }] }; }
    if (mode === "background") { return { toolCalls: [{ name: "run_command", arguments: JSON.stringify({ CommandLine: "sleep 4; printf BACKGROUND_FINISHED > background-finished.txt", WaitMsBeforeAsync: 500, toolSummary: "Synthetic background probe" }) }] }; }
    if (faults.has(mode) || mode === "mcp") { return { toolCalls: [{ name: "mcp_echo_echo", arguments: JSON.stringify({ text: "PRE_FAILURE", toolSummary: "Synthetic echo probe" }) }] }; }
    return { content: "NATIVE_GAPS_HOME" };
  });
});
const cwd = fixture.env.HOME;
assert.ok(cwd !== undefined);
const dbStop = path.join(cwd, "stop-db-observer");
const dbChunks: Buffer[] = [];
const dbErrors: Buffer[] = [];
const dbObserver = process.env.OAR_PROBE_DATABASE === "1" ? spawn("python3", [fileURLToPath(new URL("observe-db.py", import.meta.url)), cwd, dbStop], { stdio: ["ignore", "pipe", "pipe"] }) : undefined;
dbObserver?.stdout.on("data", (chunk: Buffer) => { dbChunks.push(chunk); });
dbObserver?.stderr.on("data", (chunk: Buffer) => { dbErrors.push(chunk); });
const dbExit = dbObserver === undefined ? undefined : new Promise(resolve => { dbObserver.once("exit", resolve); });
let injected = 0;
const server = http.createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => { chunks.push(chunk); });
  request.on("end", () => { void (async (): Promise<void> => {
    const data = Buffer.concat(chunks);
    const body: unknown = JSON.parse(data.toString("utf8"));
    const serialized = JSON.stringify(body);
    const record = asRecord(body);
    const hit = faults.has(mode) && serialized.includes("echo:PRE_FAILURE") && !JSON.stringify(record?.systemInstruction).includes("conversation title generator");
    provider.push({ atMs: performance.now() - started, path: request.url, body, injected: hit });
    if (hit) {
      injected += 1; mark("provider_fault", { mode, request: provider.length });
      if (mode === "cut" || mode === "stall") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "PARTIAL_GAP" }] }, index: 0 }] })}\n\n`);
        if (mode === "cut") { setTimeout(() => { response.destroy(); }, 80); }
        return;
      }
      const failures = {
        "401": [401, "UNAUTHENTICATED", "invalid_token"],
        deadline: [504, "DEADLINE_EXCEEDED", "DEADLINE_EXCEEDED"],
        quota: [429, "RESOURCE_EXHAUSTED", "QUOTA_EXHAUSTED"],
        rate: [429, "RESOURCE_EXHAUSTED", "RATE_LIMIT_EXCEEDED"],
      } as const;
      assert.ok(mode === "401" || mode === "deadline" || mode === "quota" || mode === "rate");
      const [status, nativeStatus, reason] = failures[mode];
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: status, status: nativeStatus, message: `${reason}: synthetic provider failure`, details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "synthetic.invalid" }] } }));
      return;
    }
    const upstream = await fetch(`${fixture.env.GOOGLE_GEMINI_BASE_URL}${request.url ?? ""}`, { method: "POST", headers: { "content-type": "application/json" }, body: data });
    response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
    response.end(Buffer.from(await upstream.arrayBuffer()));
  // oxlint-disable-next-line promise/prefer-await-to-then, promise/prefer-await-to-callbacks -- The HTTP event handler must observe its asynchronous proxy failure.
  })().catch(error => { mark("proxy_error", String(error)); response.destroy(); }); });
});
await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve); });
const address = server.address(); assert.ok(address !== null && typeof address === "object");
const alternative = path.join(cwd, "separate-gemini");
if (mode.startsWith("home")) {
  await mkdir(path.join(alternative, "antigravity-cli"), { recursive: true });
  await writeFile(path.join(alternative, "antigravity-cli", "settings.json"), JSON.stringify({ modelProvider: "gemini", setupComplete: true, onboardingComplete: true }));
}
let session: Session | undefined = undefined;
let result: unknown = undefined;
let failure: string | undefined = undefined;
let timer: NodeJS.Timeout | undefined = undefined;
try {
  session = await antigravitySession({ kind: "available", via: "executable", command: path.resolve(binary) }, {
    cwd, env: { ...fixture.env, GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${String(address.port)}`, ...(mode.startsWith("home") ? { GEMINI_HOME: alternative } : {}) },
    model: "gemini-3.8-flash", launchArgs: mode === "home-flag" ? ["--gemini-dir", alternative] : [],
    mcpServers: [{ name: "echo", command: process.execPath, args: [ECHO_SERVER] }],
  });
  session.rawEvents(record => { mark("record", record); });
  const timeout = new Promise<"observation_limit">((resolve) => { timer = setTimeout(() => { resolve("observation_limit"); }, limitMs); });
  result = await Promise.race([promptAndWait(session, `NATIVE_GAPS_${mode}`), timeout]);
  clearTimeout(timer); mark("prompt_result", result);
  if (result !== "observation_limit") { await delay(mode === "background" ? 12_000 : 500); }
} catch (error) { failure = String(error); }
finally {
  clearTimeout(timer);
  const files = await readdir(cwd, { recursive: true });
  const records = session?.records();
  const status = session?.status();
  await session?.dispose();
  await writeFile(dbStop, "stop");
  await dbExit;
  if (dbObserver !== undefined) { await writeFile(`${output}.db.ndjson`, Buffer.concat(dbChunks)); await writeFile(`${output}.db-errors.txt`, Buffer.concat(dbErrors)); }
  await writeFile(output, JSON.stringify({ mode, startedEpochMs, databaseObserved: dbObserver !== undefined, version: "1.5.9", fixtureHome: cwd, alternative, result, error: failure, status, injected, mainRequests, ticks, records, provider, files }, null, 2));
  server.closeAllConnections();
  await new Promise<void>(resolve => { server.close(() => { resolve(); }); });
  await fixture.stop();
}
console.log(JSON.stringify({ mode, result, error: failure, injected, mainRequests, output }));
