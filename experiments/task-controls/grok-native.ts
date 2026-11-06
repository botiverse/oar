/** ACP child cancellation, observed independently of the parent and sibling. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { grokInstallation } from "../../packages/oar/src/runtimes/grok/installation.js";
import { grokAcpProfile } from "../../packages/oar/src/runtimes/grok/session.js";
import { createRoutedAcpClientApp } from "../../packages/oar/src/shared/acp/client-app.js";
import { startAcpProcess, withAcpDeadline } from "../../packages/oar/src/shared/acp/process.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { startGrokAimock } from "../../sea-trial/harness/aimock-acp.js";

const output = path.resolve(process.argv[2] ?? "oar-trial-run/task-controls-grok");
await mkdir(output, { recursive: true });
const wire: JsonRecord[] = [];
const calls: unknown[] = [];
let rootCalls = 0;
const active = new Set<string>();
const provider = await startGrokAimock((mock) => {
  mock.on({ predicate: () => true }, async (modelRequest) => {
    calls.push(modelRequest);
    const user = JSON.stringify(modelRequest.messages.findLast((message) => message.role === "user"));
    if (modelRequest.tools?.length === 1 && modelRequest.tools[0]?.function.name === "session_title") { return { content: "Probe title" }; }
    if (user.includes("TASK_CHILD_A")) { active.add("A"); await delay(15_000); return { content: "CHILD_A_DONE" }; }
    if (user.includes("TASK_CHILD_B")) { active.add("B"); await delay(4000); return { content: "CHILD_B_DONE" }; }
    if (!user.includes("TASK_ROOT")) { return { content: "PARENT_OK" }; }
    rootCalls += 1;
    if (rootCalls <= 2) {
      const name = rootCalls === 1 ? "A" : "B";
      return { toolCalls: [{ id: `spawn_${name}`, name: "spawn_subagent", arguments: JSON.stringify({ prompt: `TASK_CHILD_${name}`, description: `TASK_${name}`, background: true }) }] };
    }
    return { content: "PARENT_OK" };
  });
});
const installation = await grokInstallation();
assert.ok(installation.kind === "available" && installation.via === "executable");
const cwd = provider.env.HOME; assert.ok(cwd !== undefined);
const waiters = new Set<() => void>();
const app = createRoutedAcpClientApp({ target: () => { throw new Error("Unexpected reverse request"); }, update: () => {}, extension: () => {}, extensionNotifications: grokAcpProfile.extensionNotifications ?? [] });
const {args} = grokAcpProfile; assert.ok(Array.isArray(args));
const native = startAcpProcess(installation.command, args, app, {
  cwd, env: { PATH: process.env.PATH ?? "", ...provider.env }, inheritStderr: false,
  incoming(message) {
    const frame = asRecord(message); if (frame !== null) { wire.push(frame); for (const notify of waiters) { notify(); } } return message;
  },
});
async function request(method: string, params: JsonRecord): Promise<JsonRecord> {
  const reply = await withAcpDeadline(native, method, 30_000, async (options) => { const answer = await native.connection.agent.request(method, params, options); return answer; });
  const result = asRecord(reply); assert.ok(result !== null); return result;
}
async function wait(predicate: () => boolean): Promise<void> {
  if (predicate()) { return; }
  const result = Promise.withResolvers<void>();
  const notify = (): void => { if (predicate()) { result.resolve(); } };
  waiters.add(notify);
  const timer = setTimeout(() => { result.reject(new Error("native evidence timeout")); }, 30_000);
  try { await result.promise; } finally { clearTimeout(timer); waiters.delete(notify); }
}
const updates = (): JsonRecord[] => wire.flatMap((frame) => { const update = asRecord(asRecord(frame.params)?.update); return update === null ? [] : [update]; });
try {
  const initialized = await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: {} }, clientInfo: { name: "oar-task-controls", version: "1" }, _meta: grokAcpProfile.initializeMeta?.({ cwd }) ?? {} });
  const auth = grokAcpProfile.selectAuthMethod?.(initialized);
  if (auth !== undefined) { await request("authenticate", { methodId: auth }); }
  const opened = await request("session/new", { cwd, mcpServers: [], _meta: { yoloMode: true } });
  const root = opened.sessionId;
  const prompt = request("session/prompt", { sessionId: root, prompt: [{ type: "text", text: "TASK_ROOT" }] });
  // oxlint-disable-next-line promise/prefer-await-to-then, unicorn/prefer-top-level-await -- Observe early rejection while waiting for child notifications.
  void prompt.catch(() => {});
  await wait(() => updates().filter((update) => update.sessionUpdate === "subagent_spawned").length >= 2);
  const [target, peer] = updates().filter((update) => update.sessionUpdate === "subagent_spawned").map((update) => update.child_session_id);
  const activeDeadline = Date.now() + 30_000;
  while (active.size < 2) {
    assert.ok(Date.now() < activeDeadline, "Both child model calls must start before cancellation");
    // oxlint-disable-next-line eslint/no-await-in-loop -- Bounded observation of independently arriving native requests.
    await delay(20);
  }
  await delay(200);
  wire.push({ probe: "child-cancel", sessionId: target, bothModelCallsStarted: true });
  await native.connection.agent.notify("session/cancel", { sessionId: target });
  await wait(() => updates().some((update) => update.sessionUpdate === "subagent_finished" && update.child_session_id === target));
  await wait(() => updates().some((update) => update.sessionUpdate === "subagent_finished" && update.child_session_id === peer));
  const targetEnd = updates().find((update) => update.sessionUpdate === "subagent_finished" && update.child_session_id === target);
  const peerEnd = updates().find((update) => update.sessionUpdate === "subagent_finished" && update.child_session_id === peer);
  const parent = await prompt;
  const followup = await request("session/prompt", { sessionId: root, prompt: [{ type: "text", text: "PARENT_FOLLOWUP" }] });
  await writeFile(path.join(output, "result.json"), JSON.stringify({ version: installation.version, targetEnd, peerEnd, parent, followup }, null, 2));
  console.log(JSON.stringify({ version: installation.version, targetEnd, peerEnd, parent: parent.stopReason, followup: followup.stopReason }));
} finally {
  native.kill(); await native.exited;
  await writeFile(path.join(output, "wire.json"), JSON.stringify(wire, null, 2));
  await writeFile(path.join(output, "provider.json"), JSON.stringify(calls, null, 2));
  await provider.stop();
}
