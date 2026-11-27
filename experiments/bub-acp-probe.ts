/*
 * What does Bub's ACP server (`bub acp`, the bub-acp-server plugin) say on
 * the wire?
 *
 * Default: starts a scripted OpenAI provider (aimock), gives Bub an isolated
 * BUB_HOME with its `openai` provider pointed at it, then drives
 * `initialize`, `session/new`, prompts (one cancelled, one overlapping a
 * running turn, one steered with `_lody/session/steer`),
 * `session/set_config_option` with listed and unlisted values,
 * `session/list`, `session/resume` of an unknown id, of a known id from
 * another cwd and from its own cwd after the process was replaced, and
 * `session/close`, printing every frame as one JSON line. No account, no
 * tokens.
 *
 * With OAR_BUB_PROBE_REAL=1 the probe keeps the caller's BUB_MODEL and
 * provider key variables (and a BUB_HOME, if set) instead of aimock.
 *
 *   OAR_BUB_BIN=/path/to/bub pnpm tsx experiments/bub-acp-probe.ts [out.jsonl]
 *
 * OBSERVED (2026-11-27, bub 0.6.3.dev1+gb2e54493a, bub-acp-server 0.1.0,
 * aimock and DeepSeek's API with deepseek-flash):
 * - initialize: protocol 1, `loadSession`, image prompts, MCP over http and
 *   sse, session list/delete/resume/close, no fork; `authMethods` empty
 *   unless the client declares terminal auth; `_meta.steering.supported`.
 * - session/new: no modes; a `model` option (category `model`, values
 *   `provider:model` from BUB_MODEL, its fallbacks and the provider's model
 *   listing) and a `reasoning_effort` option (category `thought_level`,
 *   auto, none, minimal, low, medium, high, xhigh, max, ultra; current
 *   `auto`). set_config_option answers the full configOptions with the new
 *   currentValue; an unlisted value is -32603 "Internal error" with
 *   `data.details` "invalid value for ACP config option <id>: <value>".
 * - A prompt while one runs is queued by Bub and answered after it.
 *   session/cancel ends the running prompt with stopReason `cancelled` in
 *   tens of milliseconds, also during a shell tool call.
 * - The prompt answer carries `usage` {inputTokens, outputTokens,
 *   totalTokens} for the turn; `usage_update` {used, size} arrives before
 *   it, with size BUB_ACP_SERVER_CONTEXT_WINDOW_SIZE (default 128000) when
 *   the provider reports no window.
 * - A provider error is -32603 "Internal error" with `data.details`
 *   "Provider returned HTTP <status>: <body>" (a bad or missing DeepSeek key:
 *   401 with `authentication_error`).
 * - `_lody/session/steer` without Lody clientInfo is answered only when the
 *   running step ends ({"outcome":"injected"}), or starts a new turn when
 *   nothing runs ({"outcome":"startedNewTurn"}).
 * - session/resume accepts an unknown id and any cwd: the session's tape is
 *   named after its id and cwd, so either opens an empty history, and the
 *   resume rewrites the index (the unknown id is listed from then on, the
 *   known one under the new cwd). A resume
 *   of a listed id in its own cwd, from a new process, keeps the history,
 *   model and effort.
 * - session/close returns {} and removes the session from
 *   `$BUB_HOME/acp-sessions.json` (the tape stays); ending the process
 *   leaves it listed.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { LLMock } from "@copilotkit/aimock";

const bin = process.env.OAR_BUB_BIN ?? "bub";
const out = process.argv.at(2);
const sink = out === undefined ? null : createWriteStream(out);
const real = process.env.OAR_BUB_PROBE_REAL === "1";

const mock = real ? null : new LLMock({ port: 0 });
mock?.onMessage(/slow/u, { content: "slow ok" }, { latency: 3000 });
mock?.onMessage(/^(?![\s\S]*slow)[\s\S]*$/u, { content: "ok" }, { latency: 80 });
await mock?.start();

const root = await mkdtemp(path.join(tmpdir(), "oar-bub-probe-"));
const cwd = path.join(root, "work");
await mkdir(cwd, { recursive: true });
const env: NodeJS.ProcessEnv = mock === null
  ? { ...process.env, BUB_HOME: process.env.BUB_HOME ?? path.join(root, "home") }
  : { ...process.env, BUB_HOME: path.join(root, "home"), BUB_MODEL: "openai:aimock-model", BUB_OPENAI_API_KEY: "aimock", BUB_OPENAI_API_BASE: `${mock.url}/v1` };

const started = Date.now();
function log(direction: string, frame: unknown): void {
  const line = JSON.stringify({ t: Date.now() - started, direction, frame });
  console.log(line);
  sink?.write(`${line}\n`);
}

type Message = Record<string, unknown>;
const isRecord = (value: unknown): value is Message => typeof value === "object" && value !== null && !Array.isArray(value);
function parse(line: string): Message | null {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch { return null; }
}

interface Connection {
  readonly send: (message: Message) => void;
  readonly request: (method: string, params: unknown, timeoutMs?: number) => Promise<Message>;
  readonly close: () => Promise<void>;
}

/** One `bub acp` process with its own request ids. */
function connect(label: string): Connection {
  const child = spawn(bin, ["acp"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", (chunk: Buffer) => { log(`${label} stderr`, chunk.toString()); });
  child.on("exit", (code, signal) => { log(`${label} exit`, { code, signal }); });
  let nextId = 1;
  const pending = new Map<number, (message: Message) => void>();
  const send = (message: Message): void => {
    log(`${label} out`, message);
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = parse(line);
    if (message === null) { log(`${label} in-text`, line); return; }
    log(`${label} in`, message);
    if (typeof message.id === "number" && message.method === undefined) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    } else if (typeof message.method === "string" && message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32_601, message: "not supported by probe" } });
    }
  });
  const request = async (method: string, params: unknown, timeoutMs = 60_000): Promise<Message> => {
    const id = nextId++;
    const { promise, resolve } = Promise.withResolvers<Message>();
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
    const answer = await Promise.race([promise, sleep(timeoutMs, null)]);
    pending.delete(id);
    return answer ?? { timeout: method };
  };
  const close = async (): Promise<void> => {
    child.stdin.end();
    await Promise.race([once(child, "exit"), sleep(5000)]);
    child.kill("SIGKILL");
  };
  return { send, request, close };
}

const initialize = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } };
const text = (value: string): Message[] => [{ type: "text", text: value }];
const first = connect("a");
let second: Connection | null = null;
try {
  await first.request("initialize", initialize);
  const created = await first.request("session/new", { cwd, mcpServers: [] });
  const sessionId = isRecord(created.result) ? created.result.sessionId : undefined;
  if (typeof sessionId !== "string") { throw new TypeError("session/new answered no session id"); }
  await first.request("session/prompt", { sessionId, prompt: text("say ok") });

  const slow = first.request("session/prompt", { sessionId, prompt: text("be slow") });
  await sleep(800);
  first.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  await slow;

  const running = first.request("session/prompt", { sessionId, prompt: text("slow again") });
  await sleep(300);
  log("note", { overlap: await first.request("session/prompt", { sessionId, prompt: text("overlap") }, 15_000) });
  await running;

  const steered = first.request("session/prompt", { sessionId, prompt: text("slow, then steer") });
  await sleep(300);
  log("note", { steer: await first.request("_lody/session/steer", { sessionId, prompt: text("steered") }, 15_000) });
  await steered;
  log("note", { steerIdle: await first.request("_lody/session/steer", { sessionId, prompt: text("steer while idle") }, 15_000) });
  await sleep(1000);

  const options = isRecord(created.result) && Array.isArray(created.result.configOptions) ? created.result.configOptions.filter(isRecord) : [];
  const model = options.find((option) => option.id === "model")?.currentValue;
  await first.request("session/set_config_option", { sessionId, configId: "model", value: model });
  await first.request("session/set_config_option", { sessionId, configId: "model", value: "openai:not-listed" });
  await first.request("session/set_config_option", { sessionId, configId: "reasoning_effort", value: "high" });
  await first.request("session/set_config_option", { sessionId, configId: "reasoning_effort", value: "bogus" });
  await first.request("session/list", {});
  await first.request("session/resume", { sessionId: "00000000000000000000000000000000", cwd, mcpServers: [] });
  await first.request("session/resume", { sessionId, cwd: root, mcpServers: [] });
  await first.close();

  second = connect("b");
  await second.request("initialize", initialize);
  await second.request("session/list", {});
  await second.request("session/resume", { sessionId, cwd, mcpServers: [] });
  await second.request("session/prompt", { sessionId, prompt: text("after resume") });
  await second.request("session/close", { sessionId });
  await second.request("session/list", {});
} finally {
  await first.close();
  await second?.close();
  if (mock !== null) {
    log("provider", mock.getRequests().map((entry) => ({ model: entry.body?.model, messages: entry.body?.messages.length })));
    await mock.stop();
  }
  sink?.end();
  await rm(root, { recursive: true, force: true });
}
