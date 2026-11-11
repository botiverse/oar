/* oxlint-disable max-statements, eslint/no-await-in-loop -- One app-server answers every case in order. */
/*
 * Native probe: what an older `codex app-server` answers to the requests OAR
 * sends at open and on a prompt, over raw JSON-RPC stdio. No login and no
 * provider call: a scratch CODEX_HOME, a fake API key, and only requests
 * that never reach the model.
 *
 *   pnpm tsx experiments/codex-old-releases/probe.ts <codex-binary> [bad-config]
 *
 * Cases: initialize (its userAgent carries the version); thread/start with no
 * tier and with each of default, priority, flex, fast; thread/settings/update
 * {effort}; turn/start on an unknown thread. With `bad-config` the scratch
 * config.toml is unparsable and only initialize and thread/start run.
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";

const [binary, mode] = process.argv.slice(2);
if (binary === undefined) { throw new Error("usage: probe.ts <codex-binary> [bad-config]"); }
const home = await mkdtemp(path.join(tmpdir(), "codex-old-"));
if (mode === "bad-config") { await writeFile(path.join(home, "config.toml"), "model = \"gpt-5\"\n[[broken\n"); }
const child = spawn(binary, ["app-server"], { env: { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: "sk-probe-not-a-key" }, stdio: ["pipe", "pipe", "inherit"] });
const waiting = new Map<number, (message: JsonRecord) => void>();
createInterface({ input: child.stdout }).on("line", (line) => {
  const message = asRecord(JSON.parse(line));
  const id = message?.id;
  if (message !== null && typeof id === "number") { waiting.get(id)?.(message); waiting.delete(id); }
});
let next = 1;
async function request(method: string, params: JsonRecord): Promise<JsonRecord> {
  const id = next;
  next += 1;
  const { promise, resolve } = Promise.withResolvers<JsonRecord>();
  waiting.set(id, resolve);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  const reply = await promise;
  return reply;
}
function show(label: string, message: JsonRecord): void {
  const result = asRecord(message.result);
  const summary = message.error ?? (result === null ? message : { userAgent: result.userAgent, serviceTier: result.serviceTier, threadId: asRecord(result.thread)?.id });
  console.log(label, JSON.stringify(summary));
}

show("initialize", await request("initialize", { clientInfo: { name: "oar", version: "0.0.0" }, capabilities: { experimentalApi: true } }));
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
let threadId: unknown = null;
for (const tier of mode === "bad-config" ? ["default"] : [undefined, "default", "priority", "flex", "fast"]) {
  const reply = await request("thread/start", { cwd: process.cwd(), approvalPolicy: "never", ...(tier === undefined ? {} : { serviceTier: tier }) });
  show(`thread/start serviceTier=${String(tier)}`, reply);
  threadId ??= asRecord(asRecord(reply.result)?.thread)?.id ?? null;
}
if (mode !== "bad-config") {
  show("thread/settings/update", await request("thread/settings/update", { threadId, effort: "high" }));
  show("turn/start unknown thread", await request("turn/start", { threadId: "00000000-0000-0000-0000-000000000000", input: [{ type: "text", text: "hi" }] }));
}
child.kill();
