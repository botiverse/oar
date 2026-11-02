/** Real Qwen with a synthetic provider: auxiliary memory requests, usage and disposal timing. */
/* oxlint-disable eslint/no-await-in-loop -- Native continuations and disposal must remain sequential. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promptAndWait, qwenRuntime, type Session } from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startQwenAimock } from "../../sea-trial/harness/qwen-aimock.js";

const [destination] = process.argv.slice(2);
assert.ok(destination !== undefined, "usage: OAR_QWEN_BIN=<binary> pnpm tsx experiments/qwen-native/dispose-memory.ts <output-dir>");
const snapshot = await qwenRuntime.installation();
assert.ok(snapshot.kind === "available" && snapshot.via === "executable", `Qwen unavailable: ${snapshot.kind}`);
const installation = snapshot;
const env = await startQwenAimock();
const start = performance.now();
const elapsed = (): number => Math.round((performance.now() - start) * 10) / 10;
let memoryDelayMs = 250;
const requests: {
  kind: "memory" | "main";
  body: unknown;
  receivedMs: number;
  firstChunkMs: number;
  finishedMs: number | null;
  closedMs: number | null;
  intendedUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}[] = [];
const timers = new Set<ReturnType<typeof setTimeout>>();
const server = http.createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => { chunks.push(chunk); });
  request.on("end", () => {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const parsed = asRecord(body);
    const messages = Array.isArray(parsed?.messages) ? parsed.messages.map(asRecord) : [];
    const system = JSON.stringify(messages.filter((message) => message?.role === "system"));
    const memory = system.includes("managed memory extraction subagent");
    const fact = {
      kind: memory ? "memory" : "main", body, receivedMs: elapsed(), firstChunkMs: elapsed(),
      finishedMs: null, closedMs: null,
      intendedUsage: memory
        ? { prompt_tokens: 201, completion_tokens: 11, total_tokens: 212 }
        : { prompt_tokens: 101, completion_tokens: 7, total_tokens: 108 },
    } satisfies (typeof requests)[number];
    const index = requests.push(fact) - 1;
    const entry = requests[index];
    assert.ok(entry !== undefined);
    const created = Math.floor(Date.now() / 1000);
    const frame = (delta: unknown, finishReason: string | null): string => `data: ${JSON.stringify({
      id: `chatcmpl-probe-${index}`, object: "chat.completion.chunk", created,
      model: "gpt-5.1", choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.write(frame({ role: "assistant", content: "ok" }, null));
    response.on("finish", () => { entry.finishedMs = elapsed(); });
    const timer = setTimeout(() => {
      timers.delete(timer);
      response.end(`${frame({}, "stop")}data: ${JSON.stringify({
        id: `chatcmpl-probe-${index}`, object: "chat.completion.chunk", created,
        model: "gpt-5.1", choices: [], usage: entry.intendedUsage,
      })}\n\ndata: [DONE]\n\n`);
    }, memory ? memoryDelayMs : 0);
    timers.add(timer);
    response.on("close", () => { entry.closedMs = elapsed(); clearTimeout(timer); timers.delete(timer); });
  });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address !== null && typeof address !== "string");
const baseUrl = `http://127.0.0.1:${address.port}/v1`;
const scenarios: Record<string, unknown>[] = [];
const sessions: Session[] = [];

async function scenario(name: string, prompts: readonly string[], options: { readonly resume?: string; readonly disposeDuringMemory?: boolean } = {}): Promise<string> {
  const { resume, disposeDuringMemory = false } = options;
  const firstRequest = requests.length;
  const session = await qwenRuntime.session(installation, {
    cwd: env.cwd, env: { ...env.env, OPENAI_BASE_URL: baseUrl }, ...(resume === undefined ? {} : { resume }),
  });
  sessions.push(session);
  try {
    if (resume !== undefined) { assert.equal(session.id, resume); }
    for (const input of prompts) {
      if (disposeDuringMemory) {
        const result = await session.prompt(input);
        assert.equal(result.response.body.kind, "accepted");
        const deadline = performance.now() + 30_000;
        while (!requests.slice(firstRequest).some((request) => request.kind === "memory")) {
          assert.ok(performance.now() < deadline, "memory request did not arrive");
          await sleep(10);
        }
      } else {
        const result = await promptAndWait(session, input, { timeoutMs: 30_000 });
        assert.ok(result.kind === "ended" && result.outcome.kind === "completed", JSON.stringify(result));
      }
    }
    const usageBefore = session.usage();
    const requestsBeforeDispose = requests.length - firstRequest;
    const disposeStartedMs = elapsed();
    await session.dispose();
    const disposeReturnedMs = elapsed();
    const countAfterDispose = requests.length;
    await session.dispose();
    scenarios.push({
      name, memoryDelayMs, disposeDuringMemory, sessionId: session.id, resumed: resume !== undefined,
      prompts, firstRequest, requestCount: requests.length - firstRequest, requestsBeforeDispose,
      disposeStartedMs, disposeReturnedMs, repeatDisposeExtraRequests: requests.length - countAfterDispose,
      usageBefore, usageAfter: session.usage(), records: session.records(),
    });
    return session.id;
  } finally { await session.dispose(); }
}

try {
  // Keep the existing fixture's private HOME/project and point its provider
  // at this instrumented SSE server instead of the unused aimock server.
  const settings = path.join(env.env.HOME ?? "", ".qwen", "settings.json");
  const originalBase = env.env.OPENAI_BASE_URL;
  assert.ok(originalBase !== undefined);
  const settingsText = await readFile(settings, "utf8");
  await writeFile(settings, settingsText.replaceAll(originalBase, baseUrl));
  await scenario("empty", []);
  const saved = await scenario("two-new-turns", ["OAR_MEMORY_FIRST_TURN", "OAR_MEMORY_SECOND_TURN"]);
  await scenario("resume-no-new-turn", [], { resume: saved });
  await scenario("resume-new-turn", ["OAR_MEMORY_RESUMED_TURN"], { resume: saved });
  memoryDelayMs = 1500;
  await scenario("memory-reply-delayed-1500ms", ["OAR_MEMORY_WAIT_TURN"]);
  memoryDelayMs = 8000;
  await scenario("memory-reply-delayed-8000ms", ["OAR_MEMORY_TIMEOUT_TURN"]);
  await scenario("dispose-during-memory", ["OAR_MEMORY_INTERRUPTED_TURN"], { disposeDuringMemory: true });
} finally {
  for (const session of sessions) { await session.dispose(); }
  for (const timer of timers) { clearTimeout(timer); }
  server.closeAllConnections();
  server.close();
  await once(server, "close");
  await env.stop();
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, "raw.json"), JSON.stringify({ installation, scenarios, requests }, null, 2));
  const selected = scenarios.map(({ records, ...scenarioFacts }) => ({
    ...scenarioFacts,
    nativeResults: Array.isArray(records) ? records.map((record) => asRecord(record)).flatMap((record) => {
      const body = asRecord(record?.body);
      const native = asRecord(body?.native);
      return record?.kind === "frame" && native?.type === "result"
        ? [{ seq: record.seq, receivedAt: record.receivedAt, subtype: native.subtype, usage: native.usage }]
        : [];
    }) : records,
    nativeAssistantUsage: Array.isArray(records) ? records.map((record) => asRecord(record)).flatMap((record) => {
      const native = asRecord(asRecord(record?.body)?.native);
      const usage = asRecord(native?.message)?.usage;
      return native?.type === "assistant" && usage !== undefined ? [{ seq: record?.seq, usage }] : [];
    }) : [],
    exit: Array.isArray(records) ? records.map((record) => asRecord(record)).filter((record) => record?.kind === "response" && asRecord(record.body)?.kind === "exited") : [],
  }));
  const selectedRequests = requests.map(({ body, ...request }) => {
    const messages = asRecord(body)?.messages;
    const text = JSON.stringify(messages);
    return { ...request, historyMarkers: ["OAR_MEMORY_FIRST_TURN", "OAR_MEMORY_SECOND_TURN", "OAR_MEMORY_RESUMED_TURN", "OAR_MEMORY_WAIT_TURN", "OAR_MEMORY_TIMEOUT_TURN", "OAR_MEMORY_INTERRUPTED_TURN"].filter((marker) => text.includes(marker)) };
  });
  await writeFile(path.join(destination, "selected.json"), JSON.stringify({
    version: installation.version, platform: process.platform, arch: process.arch, scenarios: selected, requests: selectedRequests,
  }, null, 2));
  process.stdout.write(`${JSON.stringify({ version: installation.version, scenarios: scenarios.length, requests: requests.length, destination })}\n`);
}
