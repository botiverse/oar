/** Lookout's 2026-10-11 goal-continuation probe, adapted to the shared local provider.
 * Run: OAR_CODEX_BIN=/absolute/codex pnpm tsx experiments/codex-goal-continuation.ts
 * No account. One client turn/start supplies outputSchema. An unfinished native goal
 * opens another turn autonomously; its requests must have no schema. Complete the
 * synthetic goal on that second turn so the native continuation loop stops.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startCodexAimock } from "../sea-trial/harness/aimock.js";
import { startAppServerClient } from "../packages/oar/src/runtimes/codex/app-server-client.js";
import { asRecord } from "../packages/oar/src/shared/json.js";

const provider = await startCodexAimock((mock) => {
  mock.on({ predicate: (request) => request.messages.at(-1)?.tool_call_id === "goal-created" }, { content: '{"answer":"more to do"}' });
  mock.on({ predicate: (request) => request.messages.at(-1)?.tool_call_id === "goal-completed" }, { content: '{"answer":"done"}' });
  mock.on({ predicate: (request) => request.messages.some((message) => message.tool_call_id === "goal-created") }, {
    toolCalls: [{ id: "goal-completed", name: "update_goal", arguments: '{"status":"complete"}' }],
  });
  mock.onMessage(/[\s\S]*/u, { toolCalls: [{ id: "goal-created", name: "create_goal", arguments: '{"objective":"Say done in the next turn"}' }] });
}, { captureRaw: true });
const root = await mkdtemp(path.join(tmpdir(), "oar-goal-schema-"));
const client = startAppServerClient(process.env.OAR_CODEX_BIN ?? "codex", provider.env, { sandbox_mode: '"danger-full-access"' });
const ended = Promise.withResolvers<void>();
const timer = setTimeout(() => { ended.reject(new Error("Goal continuation did not finish")); }, 20_000);
const starts: unknown[] = [];
let endCount = 0;
try {
  await client.request("initialize", { clientInfo: { name: "oar-goal-probe", version: "1" }, capabilities: { experimentalApi: true } });
  client.notify("initialized", {});
  const opened = await client.request("thread/start", { cwd: root, approvalPolicy: "never" });
  client.handle({ onNotification: (method, params) => {
    if (method === "turn/started") { starts.push(params); }
    if (method === "turn/completed") { endCount += 1; if (endCount === 2) { ended.resolve(); } }
  }, onServerRequest: () => {} });
  await client.request("turn/start", { threadId: asRecord(opened.thread)?.id,
    input: [{ type: "text", text: "Create a goal and finish it in a later turn" }],
    outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
  });
  await ended.promise;
  const requests = provider.raw.filter((request) => request.path.endsWith("/responses")).map((request) => {
    const body = asRecord(request.body);
    const input = Array.isArray(body?.input) ? body.input : [];
    const goalContinuation = input.some((item: unknown) => {
      const content = asRecord(item)?.content;
      return Array.isArray(content) && content.some((part: unknown) => {
        const text = asRecord(part)?.text;
        return typeof text === "string" && text.includes('<codex_internal_context source="goal">');
      });
    });
    return { goalContinuation, format: asRecord(asRecord(body?.text)?.format)?.type ?? null };
  });
  assert.equal(starts.length, 2);
  assert.ok(requests.some((request) => request.format === "json_schema"));
  const continuation = requests.filter((request) => request.goalContinuation);
  assert.ok(continuation.length > 0);
  assert.ok(continuation.every((request) => request.format === null));
  console.log(JSON.stringify({ clientTurnStarts: 1, nativeTurnStarts: starts.length, requests }));
} finally { clearTimeout(timer); client.kill(); await client.exited; await provider.stop(); await rm(root, { recursive: true, force: true }); }
