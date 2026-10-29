/* oxlint-disable eslint/no-await-in-loop, unicorn/prefer-single-call, import/max-dependencies -- Native protocol stages and polling intentionally run in order; each result stays separate evidence. */
/** Direct Qwen stream-json evidence, before the OAR adapter. Local provider and isolated home only. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { createInterface } from "node:readline";
import { LLMock } from "@copilotkit/aimock";
import { ECHO_SERVER, currentTurnSays } from "../../sea-trial/vendor/support/echo-mcp.js";
import { startRawCapture } from "../../sea-trial/harness/raw-capture.js";

const [binary, output, scenario = "plain"] = process.argv.slice(2);
assert.ok(binary !== undefined && output !== undefined, "usage: probe.ts <qwen-binary> <output-directory>");
const command = path.resolve(binary);
const out = path.resolve(output);
const root = await mkdtemp(path.join(tmpdir(), "oar-qwen-native-"));
const home = path.join(root, "home");
const cwd = path.join(root, "project");
await Promise.all([out, home, cwd].map(async (dir) => { await mkdir(dir, { recursive: true }); }));
const mock = new LLMock({ port: 0 });
mock.on({ predicate: currentTurnSays(/MCP_MARKER/u), hasToolResult: false }, { toolCalls: [{ id: "native-echo", name: "mcp__echo__echo", arguments: JSON.stringify({ text: "native-probe" }) }] });
mock.onToolResult("native-echo", { content: "tool completed" });
mock.onMessage(/SLOW_MARKER/u, { content: "slow answer" }, { latency: 3000 });
mock.onMessage(/^(?![\s\S]*(?:SLOW_MARKER|MCP_MARKER))[\s\S]*$/u, scenario === "reply-blocks"
  ? { content: "A repeated paragraph.\nA repeated paragraph.\n", reasoning: "Synthetic reasoning in a separate channel." }
  : { content: "native answer" }, { latency: 80 });
await mock.start();
const capture = await startRawCapture(mock.url);
const env: NodeJS.ProcessEnv = {};
for (const key of ["PATH", "SystemRoot", "WINDIR", "PATHEXT", "LANG", "LC_ALL"]) {
  if (process.env[key] !== undefined) { env[key] = process.env[key]; }
}
Object.assign(env, {
  HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(root, "config"),
  OPENAI_API_KEY: "aimock", OPENAI_BASE_URL: `${capture.url}/v1`, OPENAI_MODEL: "gpt-5.1",
  NO_COLOR: "1", NO_PROXY: "*",
});
if (scenario === "catalog") {
  await mkdir(path.join(home, ".qwen"), { recursive: true });
  await writeFile(path.join(home, ".qwen", "settings.json"), JSON.stringify({
    modelProviders: { openai: [{ id: "gpt-5.1", name: "Local reasoning model", baseUrl: `${capture.url}/v1`, envKey: "OPENAI_API_KEY" }] },
    security: { auth: { selectedType: "openai" } }, model: { name: "gpt-5.1" },
  }));
}
const tools = scenario === "tools" || scenario === "permission";
const sessionId = randomUUID();
const facts: unknown[] = [];
async function native(resume: boolean): Promise<void> {
  const wire: { direction: string; message: Record<string, unknown> }[] = [];
  const errors: string[] = [];
  const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--channel=SDK", "--approval-mode", scenario === "permission" ? "default" : "yolo", "--include-partial-messages", "--model", "gpt-5.1", ...(resume ? ["--resume", sessionId] : ["--session-id", sessionId])];
  const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
  const closed = Promise.withResolvers<void>();
  child.once("close", () => { closed.resolve(); });
  child.stderr.on("data", (chunk: Buffer) => { errors.push(chunk.toString()); });
  const frames: Record<string, unknown>[] = [];
  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    try { const message = asRecord(parseJson(line)); if (message === null) { errors.push(`non-json stdout: ${line}\n`); return; } frames.push(message); wire.push({ direction: "in", message });
      if (message.type === "control_request") {
        const request = asRecord(message.request);
        if (request?.subtype === "can_use_tool") { send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { behavior: "allow", updatedInput: request.input } } }); }
      }
    }
    catch { errors.push(`non-json stdout: ${line}\n`); }
  });
  const send = (message: Record<string, unknown>): void => { wire.push({ direction: "out", message }); child.stdin.write(`${JSON.stringify(message)}\n`); };
  const wait = async (predicate: (frame: Record<string, unknown>) => boolean, after = 0): Promise<Record<string, unknown>> => {
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      const frame = frames.slice(after).find((candidate) => predicate(candidate));
      if (frame !== undefined) { return frame; }
      if (child.exitCode !== null || child.signalCode !== null) { throw new Error(`native exited ${child.exitCode}: ${errors.join("")}`); }
      await sleep(20);
    }
    throw new Error(`native timed out: ${errors.join("")}`);
  };
  const request = async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = randomUUID(); const start = frames.length;
    send({ type: "control_request", request_id: id, request: body });
    const response = await wait((frame) => frame.type === "control_response" && asRecord(frame.response)?.request_id === id, start);
    return response;
  };
  const prompt = async (text: string): Promise<Record<string, unknown>> => {
    const start = frames.length;
    send({ type: "user", uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text }] } });
    const response = await wait((frame) => frame.type === "result", start);
    return response;
  };
  try {
    facts.push({ resume, initialize: await request({ subtype: "initialize", effort: "medium", ...(tools ? { mcpServers: { echo: { command: process.execPath, args: [ECHO_SERVER] } } } : {}) }) });
    for (const subtype of ["get_usage_info", "get_context_usage"]) { facts.push({ resume, beforeFirst: subtype, response: await request({ subtype }) }); }
    if (tools) { facts.push({ resume, mcp: await prompt("MCP_MARKER") }); }
    facts.push({ resume, first: await prompt(resume ? "resumed marker" : "first marker") });
    facts.push({ resume, second: await prompt("second marker") });
    for (const subtype of ["get_available_models", "get_context_usage", "get_usage_info"]) { facts.push({ resume, subtype, response: await request({ subtype }) }); }
    const start = frames.length;
    send({ type: "user", uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null, message: { role: "user", content: "SLOW_MARKER" } });
    await wait((frame) => frame.type === "system" && frame.subtype === "init", start);
    facts.push({ resume, interrupt: await request({ subtype: "interrupt" }) });
    facts.push({ resume, interrupted: await wait((frame) => frame.type === "result", start) });
    facts.push({ resume, afterAbort: await prompt("after abort marker") });
  } finally {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      if (process.platform === "win32") { child.kill(); } else { process.kill(-child.pid, "SIGTERM"); }
    }
    await closed.promise;
    reader.close();
    await writeFile(path.join(out, resume ? "resume.wire.jsonl" : "fresh.wire.jsonl"), `${wire.map((row) => JSON.stringify(row)).join("\n")}\n`);
    await writeFile(path.join(out, resume ? "resume.stderr.txt" : "fresh.stderr.txt"), errors.join(""));
  }
}
try { await native(false); await native(true); }
finally {
  await writeFile(path.join(out, "facts.json"), JSON.stringify({ sessionId, root, facts }, null, 2));
  await writeFile(path.join(out, "provider.json"), JSON.stringify(capture.requests, null, 2));
  await capture.stop(); await mock.stop();
}
console.log(`Native evidence saved to ${out}`);
