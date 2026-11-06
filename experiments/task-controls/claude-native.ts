/** Native stop_task with a surviving sibling task and a usable parent. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { launchClaude } from "../../packages/oar/src/runtimes/claude/launch.js";
import { claudeInstallation } from "../../packages/oar/src/runtimes/claude/installation.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { startClaudeAimock } from "../../sea-trial/harness/aimock.js";

const output = path.resolve(process.argv[2] ?? "oar-trial-run/task-controls-claude");
await mkdir(output, { recursive: true });
const home = await mkdtemp(path.join(tmpdir(), "oar-task-controls-"));
const wire: JsonRecord[] = [];
let calls = 0;
const provider = await startClaudeAimock((mock) => {
  mock.on({ predicate: () => true }, () => {
    calls += 1;
    if (calls === 1) {
      return { toolCalls: [
        { id: "task_a", name: "Bash", arguments: JSON.stringify({ command: "sleep 30; echo TASK_A_FINISHED", description: "TASK_A", run_in_background: true }) },
        { id: "task_b", name: "Bash", arguments: JSON.stringify({ command: "sleep 4; echo TASK_B_FINISHED", description: "TASK_B", run_in_background: true }) },
      ] };
    }
    return { content: "PARENT_OK" };
  });
});
const installation = await claudeInstallation();
assert.ok(installation.kind === "available" && installation.via === "executable");
const child = await launchClaude(installation.command, randomUUID(), {
  cwd: home, model: "haiku", userConfiguration: "exclude", env: { ...provider.env, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude") },
});
const waiters = new Set<() => void>();
child.onLine((line) => {
  const frame = asRecord(parseJson(line));
  if (frame !== null) { wire.push(frame); for (const notify of waiters) { notify(); } }
});
async function wait(predicate: () => boolean): Promise<void> {
  if (predicate()) { return; }
  const result = Promise.withResolvers<void>();
  const check = (): void => { if (predicate()) { result.resolve(); } };
  waiters.add(check);
  const timeout = setTimeout(() => { result.reject(new Error("native evidence timeout")); }, 30_000);
  try { await result.promise; } finally { clearTimeout(timeout); waiters.delete(check); }
}
let serial = 0;
async function control(request: JsonRecord): Promise<JsonRecord> {
  const id = `task-probe-${++serial}`;
  child.write(`${JSON.stringify({ type: "control_request", request_id: id, request })}\n`);
  await wait(() => wire.some((frame) => asRecord(frame.response)?.request_id === id));
  const reply = wire.find((frame) => asRecord(frame.response)?.request_id === id);
  assert.ok(reply !== undefined); return reply;
}
try {
  const initialize = await control({ subtype: "initialize" });
  assert.equal(asRecord(initialize.response)?.subtype, "success");
  child.write(`${JSON.stringify({ type: "user", message: { role: "user", content: "Start the two test tasks." } })}\n`);
  await wait(() => wire.filter((frame) => frame.subtype === "task_started").length >= 2);
  const started = wire.filter((frame) => frame.subtype === "task_started");
  const target = started.find((frame) => frame.description === "TASK_A");
  const peer = started.find((frame) => frame.description === "TASK_B");
  assert.ok(target !== undefined && peer !== undefined);
  const stop = await control({ subtype: "stop_task", task_id: target.task_id });
  await wait(() => wire.some((frame) => frame.subtype === "task_notification" && frame.task_id === target.task_id));
  const targetEnd = wire.find((frame) => frame.subtype === "task_notification" && frame.task_id === target.task_id);
  await wait(() => wire.some((frame) => frame.subtype === "task_notification" && frame.task_id === peer.task_id));
  const peerEnd = wire.find((frame) => frame.subtype === "task_notification" && frame.task_id === peer.task_id);
  const before = wire.length;
  child.write(`${JSON.stringify({ type: "user", message: { role: "user", content: "Parent follow-up." } })}\n`);
  await wait(() => wire.slice(before).some((frame) => frame.type === "result"));
  const unknown = await control({ subtype: "stop_task", task_id: "missing-task" });
  assert.equal(asRecord(stop.response)?.subtype, "success");
  assert.equal(targetEnd?.status, "stopped");
  assert.equal(peerEnd?.status, "completed");
  const result = { version: installation.version, stop, targetEnd, peerEnd, unknown, parentResult: wire.slice(before).find((frame) => frame.type === "result"), calls };
  await writeFile(path.join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ version: installation.version, stopped: targetEnd.status, peer: peerEnd.status, unknown, calls }));
} finally {
  await writeFile(path.join(output, "wire.json"), JSON.stringify(wire, null, 2));
  child.kill(); await child.exited; await provider.stop();
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
