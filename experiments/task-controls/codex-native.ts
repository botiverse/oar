/** Observe native child interruption without stopping a sibling or the parent. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { codexInstallation } from "../../packages/oar/src/runtimes/codex/installation.js";
import { startAppServerClient } from "../../packages/oar/src/runtimes/codex/app-server-client.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { startCodexAimock } from "../../sea-trial/harness/aimock.js";
import { codexTaskRecipient, codexTaskRequest } from "../../sea-trial/vendor/support/codex-task-request.js";

const qualify = (value: unknown): unknown => { const item = asRecord(value); return item?.type === "function_call" && (item.name === "spawn_agent" || item.name === "followup_task") ? { ...item, namespace: "collaboration" } : value; };

const output = path.resolve(process.argv[2] ?? "oar-trial-run/task-controls-codex");
await mkdir(output, { recursive: true });
const wire: JsonRecord[] = [];
const calls: unknown[] = [];
let rootCalls = 0;
let targetCalls = 0;
const provider = await startCodexAimock((mock) => {
  mock.on({ predicate: () => true }, async (request) => {
    calls.push(request);
    const recipient = codexTaskRecipient(request);
    const user = typeof recipient === "string" ? recipient : JSON.stringify(request.messages.findLast((message) => message.role === "user"));
    if (user === "/root/a") { targetCalls += 1; await delay(targetCalls === 1 ? 15_000 : 250); return { content: targetCalls === 1 ? "CHILD_A_DONE" : "CHILD_A_RESUMED" }; }
    if (user === "/root/b") { await delay(4000); return { content: "CHILD_B_DONE" }; }
    rootCalls += 1;
    if (rootCalls <= 2) {
      const name = rootCalls === 1 ? "a" : "b";
      return { toolCalls: [{ id: `spawn_${name}`, name: "spawn_agent", arguments: JSON.stringify({ task_name: name, message: `TASK_CHILD_${name.toUpperCase()}`, fork_turns: "none" }) }] };
    }
    if (rootCalls === 4) { return { toolCalls: [{ id: "followup_a", name: "followup_task", arguments: JSON.stringify({ target: "a", message: "TASK_CHILD_A_RESUME" }) }] }; }
    return { content: "PARENT_OK" };
  });
}, { captureRaw: true, rewriteRequest: codexTaskRequest, rewriteResponse: (body) => body.split("\n").map((line) => {
  if (!line.startsWith("data: ")) { return line; }
  const event = asRecord(parseJson(line.slice(6))); if (event === null) { return line; }
  const response = asRecord(event.response);
  return `data: ${JSON.stringify({ ...event, ...("item" in event ? { item: qualify(event.item) } : {}), ...(Array.isArray(response?.output) ? { response: { ...response, output: response.output.map(value => qualify(value)) } } : {}) })}`;
}).join("\n") });
assert.ok(provider.env !== undefined);
const installation = await codexInstallation();
assert.ok(installation.kind === "available" && installation.via === "executable");
const client = startAppServerClient(installation.command, provider.env, { "features.multi_agent": "true", "features.multi_agent_v2": "true", sandbox_mode: '"danger-full-access"' }, provider.env.CODEX_HOME);
const waiting = new Set<() => void>();
client.handle({
  onNotification(method, params) { wire.push({ method, params }); for (const notify of waiting) { notify(); } },
  onServerRequest(id, method, params) { wire.push({ id, method, params }); client.respond(id, { error: { code: -32_601, message: "unexpected request" } }); },
});
async function wait(predicate: () => boolean): Promise<void> {
  if (predicate()) { return; }
  const result = Promise.withResolvers<void>();
  const notify = (): void => { if (predicate()) { result.resolve(); } };
  waiting.add(notify);
  const timer = setTimeout(() => { result.reject(new Error("native evidence timeout")); }, 30_000);
  try { await result.promise; } finally { clearTimeout(timer); waiting.delete(notify); }
}
try {
  await client.request("initialize", { clientInfo: { name: "oar-task-controls", version: "1" }, capabilities: { experimentalApi: true } });
  client.notify("initialized", {});
  const opened = await client.request("thread/start", { model: "gpt-6.1-sol", cwd: provider.env.CODEX_HOME, approvalPolicy: "never", sandbox: "danger-full-access" });
  const root = asRecord(opened.thread)?.id;
  assert.equal(typeof root, "string");
  await client.request("turn/start", { threadId: root, input: [{ type: "text", text: "TASK_ROOT" }] });
  const children = (): string[] => [...new Set(wire.flatMap((frame) => {
    const params = asRecord(frame.params);
    return frame.method === "turn/started" && typeof params?.threadId === "string" && params.threadId !== root ? [params.threadId] : [];
  }))];
  await wait(() => children().length >= 2);
  const [target, peer] = children();
  const turn = asRecord(asRecord(wire.find((frame) => frame.method === "turn/started" && asRecord(frame.params)?.threadId === target)?.params)?.turn)?.id;
  assert.equal(typeof turn, "string");
  const interrupted = await client.request("turn/interrupt", { threadId: target, turnId: turn });
  await wait(() => wire.some((frame) => frame.method === "turn/completed" && asRecord(frame.params)?.threadId === target));
  await wait(() => wire.some((frame) => frame.method === "turn/completed" && asRecord(frame.params)?.threadId === peer));
  const endings = wire.filter((frame) => frame.method === "turn/completed");
  const targetEnd = asRecord(asRecord(endings.find((frame) => asRecord(frame.params)?.threadId === target)?.params)?.turn);
  const peerEnd = asRecord(asRecord(endings.find((frame) => asRecord(frame.params)?.threadId === peer)?.params)?.turn);
  assert.equal(targetEnd?.status, "interrupted");
  assert.equal(peerEnd?.status, "completed");
  await client.request("turn/start", { threadId: root, input: [{ type: "text", text: "PARENT_FOLLOWUP" }] });
  await wait(() => wire.filter((frame) => frame.method === "turn/completed" && asRecord(frame.params)?.threadId === root).length >= 2);
  await wait(() => wire.filter((frame) => frame.method === "turn/completed" && asRecord(frame.params)?.threadId === target).length >= 2);
  const targetTurns = wire.filter(frame => frame.method === "turn/completed" && asRecord(frame.params)?.threadId === target).map(frame => asRecord(asRecord(frame.params)?.turn));
  assert.equal(targetTurns[1]?.status, "completed");
  assert.notEqual(targetTurns[0]?.id, targetTurns[1].id);
  assert.equal(targetCalls, 2);
  await wait(() => wire.some(frame => {
    const item = asRecord(asRecord(frame.params)?.item);
    return frame.method === "item/completed" && item?.type === "subAgentActivity" && item.kind === "completed" && item.agentThreadId === target;
  }));
  const taskFacts = wire.filter(frame => asRecord(asRecord(frame.params)?.item)?.type === "subAgentActivity");
  await writeFile(path.join(output, "result.json"), JSON.stringify({ version: installation.version, interrupted, targetEnd, peerEnd, parentUsable: true, targetCanContinue: true, targetTurns, taskFacts }, null, 2));
  console.log(JSON.stringify({ version: installation.version, target: targetEnd.status, peer: peerEnd.status, parentUsable: true, targetCanContinue: true, targetTurns }));
} finally {
  client.kill(); await client.exited;
  await writeFile(path.join(output, "wire.json"), JSON.stringify(wire, null, 2));
  await writeFile(path.join(output, "provider-raw.json"), JSON.stringify(provider.raw, null, 2));
  await writeFile(path.join(output, "provider.json"), JSON.stringify(calls, null, 2));
  await provider.stop();
}
