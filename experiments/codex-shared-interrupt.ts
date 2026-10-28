/**
 * Ten native threads on one app-server; interrupt one while nine peers stream.
 * Local Responses server only. Linux procfs verifies the tool process tree.
 * OAR_CODEX_BIN=/path/to/codex pnpm tsx experiments/codex-shared-interrupt.ts [output-dir]
 * Arguments after output-dir: native-shared|oar-isolated, stream|foreground|wait, repetition,
 * optional none|archive|terminate cleanup, optional command count (1 or 2).
 * Each invocation uses fresh processes and observes a 45-second command to natural exit.
 */
/* oxlint-disable eslint/no-await-in-loop -- Each native stage depends on the previous observation, and repetitions must retain independent timing. */
/* oxlint-disable import/max-dependencies -- The experiment compares native and OAR clients with a local HTTP provider and process observer. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { defaultRuntimes, type Session } from "../packages/oar/src/index.js";
import { startAppServerClient } from "../packages/oar/src/runtimes/codex/app-server-client.js";
import { asRecord } from "../packages/oar/src/shared/json.js";
import { forest, isolatedEnvironment, newRoots, processTable, survivors, type LinuxProcess } from "./support/linux-resources.js";

const out = path.resolve(process.argv[2] ?? "oar-trial-run/codex-shared-interrupt");
const mode = process.argv[3] ?? "native-shared";
const selectedKind = process.argv[4] ?? "stream";
const selectedRepetition = Number(process.argv[5] ?? "1");
const cleanupAction = process.argv[6] ?? "none";
const commandCount = Number(process.argv[7] ?? "1");
assert.ok(["native-shared", "oar-isolated"].includes(mode));
assert.ok(["stream", "foreground", "wait"].includes(selectedKind));
await mkdir(out, { recursive: true });
const home = await mkdtemp(path.join(tmpdir(), "oar-shared-interrupt-"));
const sockets = new Set<ServerResponse>();
const releases = new Map<string, () => void>();
const stages = new Map<string, number>();
const requests: { at: number; key: string; body: unknown }[] = [];
const events: { at: number; method: string; params: Record<string, unknown> }[] = [];
const failures: string[] = [];
const results: Record<string, unknown>[] = [];
const start = performance.now();
const now = (): number => performance.now() - start;

async function until(predicate: () => boolean | Promise<boolean>, description: string, ms = 15_000): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (!await predicate()) {
    if (performance.now() >= deadline) { failures.push(description); return false; }
    await delay(20);
  }
  return true;
}

await writeFile(path.join(home, "tool.py"), [
  "import json, os, subprocess, sys, time",
  "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(45)'])",
  "with open(sys.argv[1], 'w') as f: json.dump({'parent': os.getpid(), 'child': child.pid}, f)",
  "print('TOOL_STARTED', flush=True)", "time.sleep(45)",
].join("\n"));

const server = createServer((req, res) => {
  sockets.add(res); res.on("close", () => { sockets.delete(res); });
  void (async (): Promise<void> => {
    try {
      const parts: Buffer[] = [];
      for await (const part of req) { parts.push(Buffer.isBuffer(part) ? part : Buffer.from(String(part))); }
      if (req.method !== "POST" || req.url?.endsWith("/responses") !== true) { res.writeHead(404).end(); return; }
      const body: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
      const input = asRecord(body)?.input;
      const lastUser: unknown = Array.isArray(input) ? input.findLast((item: unknown) => asRecord(item)?.role === "user") : null;
      const key = /PROBE_CASE:(?<key>[\w-]+)/u.exec(JSON.stringify(lastUser))?.groups?.key;
      assert.ok(key !== undefined, "request carries a unique case marker");
      const stage = stages.get(key) ?? 0; stages.set(key, stage + 1);
      requests.push({ at: now(), key, body });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const responseId = `resp-${String(requests.length)}`;
      let sequence = 0;
      const send = (type: string, fields: Record<string, unknown>): void => {
        if (!res.destroyed) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`); }
      };
      const finish = (output: Record<string, unknown>[]): void => {
        send("response.completed", { response: { id: responseId, object: "response", status: "completed", model: "gpt-5.1", output,
          usage: { input_tokens: 30, output_tokens: 10, total_tokens: 40 } } }); res.end();
      };
      const tool = (name: string, args: Record<string, unknown>): void => {
        const item = { id: `${responseId}-tool`, type: "function_call", call_id: `${key}-${String(stage)}`, name, arguments: JSON.stringify(args) };
        send("response.output_item.added", { output_index: 0, item });
        send("response.output_item.done", { output_index: 0, item }); finish([item]);
      };
      send("response.created", { response: { id: responseId, object: "response", status: "in_progress", output: [] } });
      if (key.endsWith("target") && !key.startsWith("stream") && stage === 0) {
        const items = Array.from({ length: commandCount }, (_value, index) => ({ id: `${responseId}-tool-${String(index)}`,
          type: "function_call", call_id: `${key}-${String(stage)}-${String(index)}`, name: "exec_command", arguments: JSON.stringify({
            cmd: `python3 '${path.join(home, "tool.py")}' '${path.join(home, `${key}-${String(index)}.json`)}'`,
            yield_time_ms: key.startsWith("foreground") ? 30_000 : 1000, max_output_tokens: 200 }) }));
        for (const [index, item] of items.entries()) {
          send("response.output_item.added", { output_index: index, item });
          send("response.output_item.done", { output_index: index, item });
        }
        finish(items);
      } else if (key.startsWith("wait") && key.endsWith("target") && stage === 1) {
        const outputs = Array.isArray(input) ? input.filter((item: unknown) => asRecord(item)?.type === "function_call_output") : [];
        const match = /(?:session ID|Session ID:)\s*(?<id>\d+)/u.exec(JSON.stringify(outputs))?.groups?.id;
        assert.ok(match !== undefined, "yielded command supplied its session ID");
        tool("write_stdin", { session_id: Number(match), chars: "", yield_time_ms: 30_000, max_output_tokens: 200 });
      } else {
        const item = { id: `${responseId}-message`, type: "message", role: "assistant", phase: "final_answer", status: "completed",
          content: [{ type: "output_text", text: "PEER_RESPONSE", annotations: [] }] };
        send("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
        send("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
        send("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: "PEER_RESPONSE" });
        releases.set(key, () => {
          send("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: "PEER_RESPONSE" });
          send("response.output_item.done", { output_index: 0, item }); finish([item]);
        });
      }
    } catch (error) { failures.push(`provider: ${String(error)}`); res.destroy(); }
  })();
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const address = server.address(); assert.ok(address !== null && typeof address !== "string");
await writeFile(path.join(home, "config.toml"), [
  'model = "gpt-5.1"', 'model_provider = "probe"', 'preferred_auth_method = "apikey"',
  '[features]', 'code_mode = false', '[model_providers.probe]', 'name = "probe"',
  `base_url = "http://127.0.0.1:${String(address.port)}/v1"`, 'env_key = "OPENAI_API_KEY"', 'wire_api = "responses"',
].join("\n"));
const before = await processTable();
const env = { ...isolatedEnvironment(home), CODEX_HOME: home, OPENAI_API_KEY: "local-probe" };
const client = mode === "native-shared" ? startAppServerClient(process.env.OAR_CODEX_BIN ?? "codex", env,
  { sandbox_mode: '"danger-full-access"' }, home) : null;
client?.handle({ onNotification: (method, params) => { events.push({ at: now(), method, params }); },
  onServerRequest: (_id, method, params) => { events.push({ at: now(), method, params }); } });
const sessions = new Map<string, Session>();
const records: unknown[] = [];
let roots: LinuxProcess[] = [];
const observed: LinuxProcess[] = [];
try {
  const ids: string[] = [];
  if (client === null) {
    const runtime = defaultRuntimes.require("codex");
    const installation = await runtime.installation?.(); assert.ok(installation?.kind === "available");
    for (let index = 0; index < 10; index += 1) {
      const session = await runtime.session(installation, { cwd: home, model: "gpt-5.1", env });
      sessions.set(session.id, session); ids.push(session.id);
      session.rawEvents((record) => {
        records.push({ at: now(), record });
        if (record.kind === "frame") {
          const native = asRecord(record.body.native);
          events.push({ at: now(), method: record.body.type, params: asRecord(native?.params) ?? native ?? {} });
        }
      }, { sessionId: session.id, afterSeq: -1 });
    }
  } else {
    await client.request("initialize", { clientInfo: { name: "oar-shared-interrupt", version: "1" }, capabilities: { experimentalApi: true } });
    client.notify("initialized", {});
    for (let index = 0; index < 10; index += 1) {
      const reply: Record<string, unknown> = await client.request("thread/start", { cwd: home, approvalPolicy: "never" });
      const id: unknown = asRecord(reply.thread)?.id; assert.equal(typeof id, "string"); ids.push(String(id));
    }
  }
  roots = await newRoots(before); assert.equal(roots.length, client === null ? 10 : 1);
  const kind = selectedKind;
  const name = `${kind}-${String(selectedRepetition)}`;
  const eventOffset = events.length;
  const turns = new Map<string, string>();
  for (const [index, threadId] of ids.entries()) {
    const key = `${name}-${index === 0 ? "target" : `peer${String(index)}`}`;
    let reply = null;
    if (client === null) {
      const result = await sessions.get(threadId)?.prompt(`PROBE_CASE:${key}`);
      assert.equal(result?.response.body.kind, "accepted");
      reply = asRecord(result.response.body.native);
    } else {
      reply = await client.request("turn/start", { threadId, input: [{ type: "text", text: `PROBE_CASE:${key}` }] });
    }
    const turnId = asRecord(reply?.turn)?.id; assert.equal(typeof turnId, "string"); turns.set(threadId, String(turnId));
  }
  const target = `${name}-target`;
  const allPeersStreaming = await until(() => ids.slice(1).every((_id, index) => releases.has(`${name}-peer${String(index + 1)}`)), `${name}: peers streaming`);
  let ready = false;
  let marker: Record<string, unknown> | null = null;
  if (kind === "stream") { ready = await until(() => releases.has(target), `${name}: target streaming`); }
  else {
    ready = await until(async () => {
      try {
        const entries = await Promise.all(Array.from({ length: commandCount }, async (_value, index) => {
          const markerText = await readFile(path.join(home, `${target}-${String(index)}.json`), "utf8");
          return asRecord(JSON.parse(markerText));
        }));
        marker = Object.fromEntries(entries.flatMap((entry, index) => Object.entries(entry ?? {}).map(([key, value]) => [`${String(index)}-${key}`, value])));
        return kind !== "wait" || (stages.get(target) ?? 0) >= 2;
      } catch { return false; }
    }, `${name}: tool running and requested wait dispatched`);
    await delay(200);
  }
  const preInterrupt = forest(await processTable(), roots);
  const tools = preInterrupt.filter((entry) => marker !== null && Object.values(marker).includes(entry.pid));
  const atInterrupt = now();
  const response = client === null
    ? await sessions.get(ids[0] ?? "")?.abort()
    : await client.request("turn/interrupt", { threadId: ids[0], turnId: turns.get(ids[0] ?? "") });
  const endFor = (threadId: string): (typeof events)[number] | undefined => events.slice(eventOffset).find((event) => event.method === "turn/completed" && event.params.threadId === threadId && asRecord(event.params.turn)?.id === turns.get(threadId));
  const ended = await until(() => endFor(ids[0] ?? "") !== undefined, `${name}: target turn ended`, 10_000);
  const remainingAtEnd = await survivors(tools);
  const peersEndedBeforeRelease = ids.slice(1).filter((id) => endFor(id) !== undefined);
  const toolObservations: { atMs: number; processes: LinuxProcess[] }[] = [];
  const backgroundTerminals = client === null ? null : await client.request("thread/backgroundTerminals/list", { threadId: ids[0] });
  let explicitCleanup: { atMs: number; response: unknown; completedAtMs: number } | null = null;
  let firstAllStoppedMs: number | null = tools.length === 0 ? 0 : null;
  const observationStart = now();
  while (tools.length > 0 && now() - atInterrupt < 50_000) {
    if (cleanupAction !== "none" && explicitCleanup === null && now() - atInterrupt >= 2000) {
      assert.ok(client !== null, "explicit native cleanup uses the shared app-server");
      const atMs = now() - atInterrupt;
      const terminals = Array.isArray(backgroundTerminals?.data) ? backgroundTerminals.data : [];
      const reply = cleanupAction === "archive"
        ? await client.request("thread/archive", { threadId: ids[0] })
        : await client.request("thread/backgroundTerminals/terminate", { threadId: ids[0], processId: asRecord(terminals[0])?.processId });
      explicitCleanup = { atMs, response: reply, completedAtMs: now() - atInterrupt };
    }
    const processes = await survivors(tools);
    toolObservations.push({ atMs: now() - atInterrupt, processes });
    if (processes.every((entry) => entry.state === "Z")) { firstAllStoppedMs = now() - atInterrupt; break; }
    await delay(200);
  }
  for (let index = 1; index < 10; index += 1) { releases.get(`${name}-peer${String(index)}`)?.(); }
  const peersFinished = await until(() => ids.slice(1).every((id) => endFor(id) !== undefined), `${name}: peers completed`);
  const peerEnds = ids.slice(1).map((id) => endFor(id) ?? null);
  const peerStatusesCompleted = peerEnds.every((event) => asRecord(event?.params.turn)?.status === "completed");
  const stillAliveAt = (ms: number): unknown => toolObservations.find((entry) => entry.atMs >= ms) ?? null;
  const lifecycle: unknown[] = [];
  if (client !== null && cleanupAction === "archive") {
    for (const method of ["thread/archive", "thread/read", "thread/resume", "thread/unarchive", "thread/resume", "thread/read"]) {
      const params = { threadId: ids[0], includeTurns: true };
      const reply = await client.request(method, params).then((value) => ({ value }), (error: unknown) => ({ error: String(error) }));
      lifecycle.push({ method, params, ...reply });
    }
  }
  const result = { name, mode, commandSeconds: 45, commandCount, lifecycle, ready, allPeersStreaming, interruptResponse: response, ended,
    interruptToEndMs: ended ? (endFor(ids[0] ?? "")?.at ?? atInterrupt) - atInterrupt : null,
    targetEnd: endFor(ids[0] ?? "") ?? null, marker, backgroundTerminals, cleanupAction, explicitCleanup,
    processTreeBefore: preInterrupt, toolsBefore: tools,
    toolsAliveAtTurnEnd: remainingAtEnd, observationStartMs: observationStart - atInterrupt,
    atTwoSeconds: stillAliveAt(2000), atTenSeconds: stillAliveAt(10_000), firstAllStoppedMs,
    toolObservations, peersEndedBeforeRelease, peersFinished, peerStatusesCompleted, peerEnds,
    toolsAfter: await survivors(tools) };
  results.push(result);
  process.stdout.write(`${JSON.stringify({ name, mode, ready, ended, interruptToEndMs: result.interruptToEndMs, firstAllStoppedMs, peerStatusesCompleted })}\n`);
  await writeFile(path.join(out, `${name}.json`), `${JSON.stringify({ result, events: events.slice(eventOffset), requests, records }, null, 2)}\n`);
  observed.push(...preInterrupt);
  assert.ok(ready && allPeersStreaming && ended && peersFinished && peerStatusesCompleted, "native completion or peer isolation failed; see retained artifact");
  // A slow natural exit remains a negative interrupt result, even though cleanup is no longer needed.
  assert.ok(firstAllStoppedMs !== null && firstAllStoppedMs <= (explicitCleanup?.completedAtMs ?? 0) + 2000,
    "tool processes survived the requested interruption or explicit cleanup for more than two seconds");
} finally {
  observed.push(...forest(await processTable(), roots));
  if (client !== null) { client.kill(); await client.exited; }
  await Promise.allSettled([...sessions.values()].map(async (session) => { await session.dispose(); }));
  for (const socket of sockets) { socket.destroy(); }
  await server[Symbol.asyncDispose](); await delay(1000);
  await writeFile(path.join(out, "summary.json"), `${JSON.stringify({ results, failures, cleanupSurvivors: await survivors(observed) }, null, 2)}\n`);
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
