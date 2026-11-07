import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { codexInstallation, codexSession, promptAndWait, type Session } from "../../packages/oar/src/index.js";
import { startCodexAimock } from "../../sea-trial/harness/aimock.js";
import { codexTaskRecipient, codexTaskRequest } from "../../sea-trial/vendor/support/codex-task-request.js";

const output = process.argv[2] ?? "oar-trial-run/tool-activity";
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(tmpdir(), "oar-collab-audit-"));
const requests: unknown[] = [];
let rootCalls = 0;
const provider = await startCodexAimock(mock => {
  mock.on({ predicate: () => true }, async request => {
    requests.push(request);
    if (codexTaskRecipient(request) !== "/root") { await delay(250); return { content: "CHILD_DONE" }; }
    rootCalls += 1;
    if (rootCalls === 1) { return { toolCalls: [{ id: "audit_spawn", name: "spawn_agent", arguments: JSON.stringify({ message: "AUDIT_CHILD", task_name: "audit", fork_turns: "none" }) }] }; }
    if (rootCalls === 2) { return { toolCalls: [{ id: "audit_wait", name: "wait_agent", arguments: '{"timeout_ms":10000}' }] }; }
    return { content: "AUDIT_DONE" };
  });
}, { captureRaw: true, rewriteRequest: codexTaskRequest, rewriteResponse: body => body.replaceAll('"name":"spawn_agent"', '"name":"spawn_agent","namespace":"collaboration"').replaceAll('"name":"wait_agent"', '"name":"wait_agent","namespace":"collaboration"') });
const installation = await codexInstallation(); assert.ok(installation.kind === "available");
let session: Session | null = null;
try {
  session = await codexSession(installation, { cwd: root, env: { ...provider.env }, model: "gpt-6.1-sol", launchArgs: ["-c", "features.multi_agent=true", "-c", "features.multi_agent_v2=true"] });
  const result = await promptAndWait(session, "AUDIT_ROOT", { timeoutMs: 30_000 });
  assert.equal(result.kind, "ended");
  await delay(1000);
  const events = session.records().flatMap(record => record.kind === "frame" ? record.body.events : []);
  assert.deepEqual(events.filter(event => "callId" in event && event.callId === "audit_wait"), [
    { kind: "tool_call_started", callId: "audit_wait", tool: "collabAgentToolCall", input: '{"tool":"wait","prompt":null}' },
    { kind: "tool_call_ended", callId: "audit_wait", result: "ok" },
  ]);
} finally {
  await writeFile(path.join(output, "collab.json"), JSON.stringify({ installation, records: session?.records(), requests, raw: provider.raw }, null, 2));
  await session?.dispose(); await provider.stop();
  await rm(root, { recursive: true, force: true });
}
