import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startClaudeAimock, startCodexAimock, type LLMock } from "../../sea-trial/harness/aimock.js";
import { startAppServerClient } from "../../packages/oar/src/runtimes/codex/app-server-client.js";
import { resolveExecutable, spawnLineProcess } from "../../packages/oar/src/shared/executable/index.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";

const [id] = process.argv.slice(2);
assert.ok(id === "codex" || id === "claude");
const inputId = "11111111-2222-4333-8444-555555555555";
const marker = "OAR_NATIVE_STEER_ID_7C92";
const provider: boolean[] = [];
const frames: unknown[] = [];
function configure(mock: LLMock): void {
  mock.onMessage(/[\s\S]*/u, (request: { messages?: unknown }) => {
    provider.push(JSON.stringify(request.messages).includes(marker));
    return provider.length === 1
      ? { toolCalls: [{ name: id === "claude" ? "Bash" : "exec_command", arguments: JSON.stringify(id === "claude" ? { command: "sleep 2; echo boundary" } : { cmd: "sleep 2; echo boundary" }) }] }
      : { content: "scripted completion" };
  });
}
const env = await (id === "claude" ? startClaudeAimock : startCodexAimock)(configure);
const cwd = await mkdtemp(path.join(tmpdir(), "oar-native-steer-"));
const command = resolveExecutable(id);
assert.ok(command !== null);
const done = Promise.withResolvers<void>();
let sent = false;
let reply: unknown = null;
if (id === "codex") {
  const client = startAppServerClient(command, env.env, { sandbox_mode: '"danger-full-access"' }, cwd);
  const timer = setTimeout(() => { client.kill(); done.reject(new Error("probe timeout")); }, 25_000);
  try {
    await client.spawned;
    await client.request("initialize", { clientInfo: { name: "oar-identity-probe", version: "1" }, capabilities: { experimentalApi: true } });
    client.notify("initialized", {});
    const opened = await client.request("thread/start", { cwd, model: "gpt-5.1", approvalPolicy: "never" });
    const threadId = asRecord(opened.thread)?.id;
    assert.equal(typeof threadId, "string");
    client.handle({ onServerRequest: () => {}, onNotification: (method, params) => {
      const item = asRecord(params.item);
      if (item?.type === "userMessage") {frames.push({ method, ...params });}
      if (!sent && method === "item/started" && item?.type === "commandExecution") {
        sent = true;
        void (async (): Promise<void> => {
          try { reply = await client.request("turn/steer", { threadId, expectedTurnId: params.turnId, clientUserMessageId: inputId, input: [{ type: "text", text: marker }] }); }
          catch (error) { done.reject(error); }
        })();
      }
      if (method === "turn/completed") {done.resolve();}
    } });
    await client.request("turn/start", { threadId, input: [{ type: "text", text: "run the tool" }] });
    await done.promise;
  } finally {
    clearTimeout(timer);
    client.kill();
    await client.exited;
    await env.stop();
  }
} else {
  const child = spawnLineProcess(command, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages", "--dangerously-skip-permissions", "--model", "haiku"], {
    cwd, env: { ...process.env, ...env.env, CLAUDECODE: undefined, CLAUDE_CONFIG_DIR: cwd, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
  });
  const timer = setTimeout(() => { child.kill(); done.reject(new Error("probe timeout")); }, 25_000);
  const send = (text: string, uuid?: string): void => {
    child.write(`${JSON.stringify({ type: "user", ...(uuid === undefined ? {} : { uuid }), message: { role: "user", content: [{ type: "text", text }] } })}\n`);
  };
  try {
    child.onLine((line) => {
      const frame = asRecord(parseJson(line));
      if (frame?.type === "user" || frame?.type === "system" && frame.subtype !== "init") {frames.push(frame);}
      if (!sent && frame?.type === "assistant") { sent = true; send(marker, inputId); }
      if (frame?.type === "result") {done.resolve();}
    });
    await child.spawned;
    send("run the tool");
    await done.promise;
  } finally {
    clearTimeout(timer);
    child.kill();
    await child.exited;
    await env.stop();
  }
}
process.stdout.write(`${JSON.stringify({ runtime: id, inputId, sent, reply, provider, frames }, null, 2)}\n`);
assert.ok(provider.includes(true), "steer absent at mock provider");
assert.ok(JSON.stringify(frames).includes(inputId), "input identity was not echoed");
