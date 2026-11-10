/* oxlint-disable max-statements -- One native session runs the four cases in order. */
/*
 * Native probe: Grok's `_x.ai/interject` over raw ACP stdio, against a
 * scripted local provider (no login, no tokens).
 *
 *   pnpm tsx experiments/grok-interject/probe.ts <grok-binary> [out.json]
 *
 * Cases:
 *   A  interject while a slow tool runs: same prompt answer, no cancel, and
 *      the interjection reaches the next provider request.
 *   B  interject while idle: Grok runs it as its own turn.
 *   C  interject while a slow tool runs, then session/cancel.
 *   D  the client's `_meta.promptId` on session/prompt is used verbatim.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { startGrokAimock } from "../../sea-trial/harness/aimock-acp.js";

const [binary, out = "grok-interject-probe.json"] = process.argv.slice(2);
if (binary === undefined) { throw new Error("usage: probe.ts <grok-binary> [out.json]"); }

const json = (value: unknown): string => JSON.stringify(value);
/** The newest user or tool message a provider request carries, as JSON text. */
function lastInput(body: unknown): string {
  const messages: unknown = asRecord(body)?.messages;
  const last: unknown = Array.isArray(messages) ? messages.findLast((message: unknown) => ["user", "tool"].includes(String(asRecord(message)?.role))) : undefined;
  return json(asRecord(last)?.content ?? "");
}
function offersTools(body: unknown): boolean {
  const tools: unknown = asRecord(body)?.tools;
  return Array.isArray(tools) && tools.length > 0;
}
function sleepCall(id: string, seconds: number): { toolCalls: { id: string; name: string; arguments: string }[] } {
  return { toolCalls: [{ id, name: "run_terminal_command", arguments: json({ command: `sleep ${seconds}; echo slept-${id}`, description: "sleep" }) }] };
}

const provider = await startGrokAimock((mock) => {
  // Grok's titling and summary calls offer no tools.
  mock.on({ predicate: (body) => !offersTools(body) }, { content: "a title" });
  for (const label of ["A", "B", "C"]) {
    mock.on({ predicate: (body) => lastInput(body).includes(`INTERJECT_${label}`) }, { content: `ack-${label}` });
  }
  mock.on({ predicate: (body) => lastInput(body).includes("slept-") }, { content: "after-tool" });
  mock.on({ predicate: (body) => lastInput(body).includes("CASE_A") }, sleepCall("a", 4));
  mock.on({ predicate: (body) => lastInput(body).includes("CASE_C") }, sleepCall("c", 6));
  mock.on({ predicate: () => true }, { content: "fallback" });
});

const cwd = await mkdtemp(path.join(tmpdir(), "grok-interject-cwd-"));
const child = spawn(binary, ["agent", "stdio"], { cwd, env: { ...process.env, ...provider.env }, stdio: ["pipe", "pipe", "pipe"] });
const started = Date.now();
const log: { readonly ms: number; readonly dir: "in" | "out"; readonly msg: JsonRecord }[] = [];
const waiters: { readonly match: (msg: JsonRecord) => boolean; readonly resolve: (msg: JsonRecord) => void }[] = [];
const answers = new Map<number, (msg: JsonRecord) => void>();
let nextId = 0;
let stderr = "";
child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

function write(msg: JsonRecord): void {
  log.push({ ms: Date.now() - started, dir: "out", msg });
  child.stdin.write(`${json(msg)}\n`);
}
function receive(line: string): void {
  let parsed: unknown = null;
  try { parsed = JSON.parse(line); } catch { return; }
  const msg = asRecord(parsed);
  if (msg === null) { return; }
  log.push({ ms: Date.now() - started, dir: "in", msg });
  const { id } = msg;
  if (typeof id === "number" && (msg.result !== undefined || msg.error !== undefined)) {
    answers.get(id)?.(msg);
    answers.delete(id);
  } else if (typeof msg.method === "string" && id !== undefined) {
    // A reverse request (permission): allow once when offered, else refuse.
    const offered: unknown = asRecord(msg.params)?.options;
    const allow = Array.isArray(offered) ? offered.map((option: unknown) => asRecord(option)).find((option) => option?.kind === "allow_once") : undefined;
    write(allow === undefined || allow === null
      ? { jsonrpc: "2.0", id, error: { code: -32_601, message: "unsupported" } }
      : { jsonrpc: "2.0", id, result: { outcome: { outcome: "selected", optionId: allow.optionId } } });
  }
  for (const waiter of waiters.filter((entry) => entry.match(msg))) {
    waiters.splice(waiters.indexOf(waiter), 1);
    waiter.resolve(msg);
  }
}
createInterface({ input: child.stdout }).on("line", receive);

// oxlint-disable-next-line typescript/promise-function-async -- Returns the pending answer without awaiting it here.
function call(method: string, params: JsonRecord): Promise<JsonRecord> {
  nextId += 1;
  const answer = Promise.withResolvers<JsonRecord>();
  answers.set(nextId, answer.resolve);
  write({ jsonrpc: "2.0", id: nextId, method, params });
  return answer.promise;
}
async function expire(ms: number): Promise<never> {
  await delay(ms);
  throw new Error(`timeout after ${ms} ms`);
}
// oxlint-disable-next-line typescript/promise-function-async -- Returns the race without awaiting it here.
function frame(match: (msg: JsonRecord) => boolean, ms = 60_000): Promise<JsonRecord> {
  const seen = Promise.withResolvers<JsonRecord>();
  waiters.push({ match, resolve: seen.resolve });
  return Promise.race([seen.promise, expire(ms)]);
}
const updateOf = (msg: JsonRecord): JsonRecord | null => asRecord(asRecord(msg.params)?.update);
const isToolCall = (id: string) => (msg: JsonRecord): boolean => updateOf(msg)?.sessionUpdate === "tool_call" && updateOf(msg)?.toolCallId === id;
const isTurnEnd = (msg: JsonRecord): boolean => updateOf(msg)?.sessionUpdate === "turn_completed";
const providerSaw = (text: string): boolean => provider.raw.some(({ body }) => json(body).includes(text));

const results: JsonRecord = {};
try {
  const initializeAnswer = await call("initialize", { protocolVersion: 1, clientCapabilities: {}, _meta: { clientIdentifier: "oar", clientType: "generic", startupHints: { nonInteractive: true, skipGitStatus: true, skipProjectLayout: true } } });
  const initialized = asRecord(initializeAnswer.result);
  // oxlint-disable-next-line eslint/no-underscore-dangle -- Native ACP extension envelope.
  const preferred = asRecord(initialized?._meta)?.defaultAuthMethodId;
  if (typeof preferred === "string") { await call("authenticate", { methodId: preferred }); }
  const created = await call("session/new", { cwd, mcpServers: [], _meta: { yoloMode: true } });
  const sessionId = asRecord(created.result)?.sessionId;
  if (typeof sessionId !== "string") { throw new TypeError("no session id"); }

  // A and D
  const promptA = call("session/prompt", { sessionId, prompt: [{ type: "text", text: "CASE_A" }], _meta: { promptId: "oar-prompt-a" } });
  await frame(isToolCall("a"));
  await delay(1000);
  const interjectA = await call("_x.ai/interject", { sessionId, text: "INTERJECT_A", interjectionId: "input-a" });
  const answerA = await promptA;
  await delay(1500);
  results.A = { interjectAnswer: interjectA, promptAnswer: answerA, providerSawInterjection: providerSaw("INTERJECT_A") };

  // B
  const interjectB = await call("_x.ai/interject", { sessionId, text: "INTERJECT_B", interjectionId: "input-b" });
  const endB = await frame((msg) => isTurnEnd(msg) && json(msg).includes("interject-fallback-"), 30_000).catch((error: unknown) => ({ error: String(error) }));
  await delay(1500);
  results.B = { interjectAnswer: interjectB, turnCompleted: endB };

  // C
  const promptC = call("session/prompt", { sessionId, prompt: [{ type: "text", text: "CASE_C" }], _meta: { promptId: "oar-prompt-c" } });
  await frame(isToolCall("c"));
  await delay(1000);
  const interjectC = await call("_x.ai/interject", { sessionId, text: "INTERJECT_C", interjectionId: "input-c" });
  await delay(500);
  const cancelledAt = log.length;
  write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  const answerC = await promptC;
  await delay(8000);
  results.C = {
    interjectAnswer: interjectC,
    promptAnswer: answerC,
    providerSawInterjection: providerSaw("INTERJECT_C"),
    turnsAfterCancel: log.slice(cancelledAt).filter(({ msg }) => isTurnEnd(msg) && !json(msg).includes("oar-prompt-")).map(({ msg }) => updateOf(msg)?.prompt_id),
  };
} catch (error) {
  results.error = String(error);
} finally {
  child.kill("SIGTERM");
  await provider.stop().catch(() => null);
}
const version = spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout.trim();
await writeFile(out, json({ version, results, stderrTail: stderr.slice(-4000), log }));
console.log(JSON.stringify({ version, results }, null, 2));
process.exit(0);
