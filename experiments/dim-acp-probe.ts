/*
 * What does Dim's ACP gateway (`dima acp`) say on the wire?
 *
 * Default: starts a scripted OpenAI chat provider (aimock), gives Dim an
 * isolated home and a `--model-config` file pointing at it, then drives
 * `initialize`, `session/new`, prompts (one cancelled, one overlapping a
 * running turn), `session/set_config_option`, `session/set_mode`,
 * `session/list`, `session/resume` of an unknown and a known id and a last
 * prompt, printing every frame as one JSON line. No account, no tokens.
 *
 * With OAR_DIM_PROBE_HOME the probe uses that existing home instead, with
 * no `--model-config`: a home whose provider catalog (TUI `/connect`, a
 * custom OpenAI-compatible provider) points at a provider you started, so
 * the gateway's catalog-backed `model` config option can be observed.
 * OAR_DIM_PROBE_MODEL names the catalog model id to switch to.
 *
 *   OAR_DIM_BIN=/path/to/dima pnpm tsx experiments/dim-acp-probe.ts [out.jsonl]
 *
 * OBSERVED (2026-11-26, dimcode 0.1.0-alpha.29, both modes):
 * - initialize: protocol 1, `loadSession`, image prompts, session
 *   list/delete/fork/resume/close; `authMethods` is empty with a
 *   `--model-config` file and offers Dim's own login on a catalog home.
 * - session/new: modes read-only, workspace-write (current), full-access,
 *   also as a `mode` config option. A `model` option appears only on a
 *   catalog home (values are bare catalog ids); a `thought_level` option only
 *   for a model that declares reasoning. set_config_option answers the full
 *   configOptions with the new currentValue.
 * - A prompt while one runs: -32001 `session_busy`. session/cancel ends the
 *   running prompt with stopReason `cancelled`.
 * - session/resume of an unknown id: -32002 "Resource not found"; of a known
 *   id from another cwd: -32001 `session_invalid_input` ("Session cwd does
 *   not match expectedCwd"). session/close ends the saved session, so a later
 *   resume answers -32002.
 * - The first `dima acp` of a home starts the home's App Server
 *   (`dimcode-server`) as its own child; it serves every later client.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { LLMock } from "@copilotkit/aimock";

const bin = process.env.OAR_DIM_BIN ?? "dima";
const out = process.argv.at(2);
const sink = out === undefined ? null : createWriteStream(out);
const catalogHome = process.env.OAR_DIM_PROBE_HOME;
const switchModel = process.env.OAR_DIM_PROBE_MODEL ?? "aimock-other";

const mock = catalogHome === undefined ? new LLMock({ port: 0 }) : null;
mock?.onMessage(/slow/u, { content: "slow ok" }, { latency: 3000 });
mock?.onMessage(/^(?![\s\S]*slow)[\s\S]*$/u, { content: "ok" }, { latency: 80 });
await mock?.start();

const root = await mkdtemp(path.join(tmpdir(), "oar-dim-probe-"));
const home = catalogHome ?? path.join(root, "home");
const cwd = path.join(root, "work");
await mkdir(home, { recursive: true });
await mkdir(cwd, { recursive: true });
const args = ["acp", "--home", home];
if (mock !== null) {
  const modelConfig = path.join(root, "model.json");
  await writeFile(modelConfig, JSON.stringify({
    defaultModel: { providerId: "aimock", modelId: "aimock-model" },
    providers: [{
      id: "aimock",
      kind: "openai-chat",
      apiKeyEnv: "AIMOCK_API_KEY",
      baseUrl: `${mock.url}/v1`,
      models: [
        { id: "aimock-model", contextWindow: 128_000, maxOutputTokens: 4096, config: { maxTokens: 1024 } },
        { id: "aimock-other", contextWindow: 64_000, maxOutputTokens: 4096, config: { maxTokens: 1024 } },
      ],
    }],
  }));
  args.push("--model-config", modelConfig);
}

const child = spawn(bin, args, { cwd, env: { ...process.env, AIMOCK_API_KEY: "aimock" }, stdio: ["pipe", "pipe", "pipe"] });
const started = Date.now();
function log(direction: string, frame: unknown): void {
  const line = JSON.stringify({ t: Date.now() - started, direction, frame });
  console.log(line);
  sink?.write(`${line}\n`);
}
child.stderr.on("data", (chunk: Buffer) => { log("stderr", chunk.toString()); });
child.on("exit", (code, signal) => { log("exit", { code, signal }); });

type Message = Record<string, unknown>;
const isRecord = (value: unknown): value is Message => typeof value === "object" && value !== null && !Array.isArray(value);
function parse(line: string): Message | null {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch { return null; }
}

let nextId = 1;
const pending = new Map<number, (message: Record<string, unknown>) => void>();
function send(message: Record<string, unknown>): void {
  log("out", message);
  child.stdin.write(`${JSON.stringify(message)}\n`);
}
createInterface({ input: child.stdout }).on("line", (line) => {
  const message = parse(line);
  if (message === null) { log("in-text", line); return; }
  log("in", message);
  if (typeof message.id === "number" && message.method === undefined) {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  } else if (typeof message.method === "string" && message.id !== undefined) {
    // Agent -> client requests: allow permissions, refuse the rest.
    if (message.method === "session/request_permission") {
      const options = isRecord(message.params) && Array.isArray(message.params.options) ? message.params.options.filter(isRecord) : [];
      const allow = options.find((option) => typeof option.kind === "string" && option.kind.startsWith("allow"));
      send({ jsonrpc: "2.0", id: message.id, result: { outcome: allow === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId: allow.optionId } } });
    } else {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32_601, message: "not supported by probe" } });
    }
  }
});

async function request(method: string, params: unknown, timeoutMs = 60_000): Promise<Message> {
  const id = nextId++;
  const { promise, resolve } = Promise.withResolvers<Message>();
  pending.set(id, resolve);
  send({ jsonrpc: "2.0", id, method, params });
  const answer = await Promise.race([promise, sleep(timeoutMs, null)]);
  pending.delete(id);
  return answer ?? { timeout: method };
}

try {
  await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  const created = await request("session/new", { cwd, mcpServers: [] });
  const sessionId = isRecord(created.result) ? created.result.sessionId : undefined;
  if (typeof sessionId !== "string") { throw new TypeError("session/new answered no session id"); }
  await request("session/prompt", { sessionId, prompt: [{ type: "text", text: "say ok" }] });

  const slow = request("session/prompt", { sessionId, prompt: [{ type: "text", text: "be slow" }] });
  await sleep(800);
  send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  await slow;

  const first = request("session/prompt", { sessionId, prompt: [{ type: "text", text: "slow again" }] });
  await sleep(300);
  log("note", { overlap: await request("session/prompt", { sessionId, prompt: [{ type: "text", text: "overlap" }] }, 15_000) });
  await first;

  await request("session/set_config_option", { sessionId, configId: "model", value: switchModel });
  await request("session/set_config_option", { sessionId, configId: "effort", value: "high" });
  await request("session/set_mode", { sessionId, modeId: "full-access" });
  await request("session/list", { cwd });
  await request("session/resume", { sessionId: "00000000-0000-0000-0000-000000000000", cwd, mcpServers: [] });
  await request("session/resume", { sessionId, cwd: root, mcpServers: [] });
  await request("session/resume", { sessionId, cwd, mcpServers: [] });
  await request("session/prompt", { sessionId, prompt: [{ type: "text", text: "after resume" }] });
} finally {
  child.stdin.end();
  await Promise.race([once(child, "exit"), sleep(5000)]);
  child.kill("SIGKILL");
  if (catalogHome === undefined) {
    const stop = spawn(bin, ["daemon", "stop", "--home", home], { stdio: "ignore" });
    await once(stop, "exit");
  }
  if (mock !== null) {
    log("provider", mock.getRequests().map((entry) => ({ model: entry.body?.model, messages: entry.body?.messages.length })));
    await mock.stop();
  }
  sink?.end();
  await rm(root, { recursive: true, force: true });
}
