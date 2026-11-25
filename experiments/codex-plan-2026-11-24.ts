/** Codex's real app-server (0.171.0) against a scripted local Responses stream: what `turn/plan/updated` carries.
 * Run: OAR_CODEX_BIN=/absolute/codex pnpm tsx experiments/codex-plan-2026-11-24.ts [output-dir]
 * No login and no model calls: the provider is a local SSE server, and the model's plan is the tool call it scripts.
 * The checklist tool is enabled with `[tools.update_plan] enabled = true` (the flag OAR does not set itself).
 * Writes the captured notifications, the tool's own schema and the recorded OAR frames as selected evidence.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { defaultRuntimes, eventsOf, type Event, type RawEvent } from "../packages/oar/src/index.js";
import { asRecord, type JsonRecord } from "../packages/oar/src/shared/json.js";

const out = path.resolve(process.argv[2] ?? "experiments");
const binary = process.env.OAR_CODEX_BIN ?? "codex";
const version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
const runtime = defaultRuntimes.require("codex");
const detected = await runtime.installation?.();
assert.ok(detected?.kind === "available", "codex must be installed");

// Turn one sends two whole lists (a start, then every step done); turn two sends the model's own empty list.
const SCRIPT: readonly (Record<string, unknown> | null)[] = [
  { plan: [{ step: "Collect the native facts", status: "in_progress" }, { step: "Write the checklist spec", status: "pending" }], explanation: "Two steps to prove the wire" },
  { plan: [{ step: "Collect the native facts", status: "completed" }, { step: "Write the checklist spec", status: "completed" }] },
  null,
  { plan: [] },
  null,
];
const home = await mkdtemp(path.join(tmpdir(), "oar-codex-plan-"));
const requests: JsonRecord[] = [];
const toolDefinitions: JsonRecord[] = [];
const sockets = new Set<ServerResponse>();

function scripted(index: number): Record<string, unknown> {
  const plan = SCRIPT[index] ?? null;
  if (plan !== null) {
    return { id: `plan-item-${String(index)}`, type: "function_call", call_id: `plan-call-${String(index)}`, name: "update_plan", arguments: JSON.stringify(plan) };
  }
  const id = `message-${String(index)}`;
  return { id, type: "message", role: "assistant", phase: "final_answer", status: "completed", content: [{ type: "output_text", text: `PLAN_TURN_DONE_${String(index)}`, annotations: [] }] };
}

const server = createServer((req, res) => {
  sockets.add(res);
  res.on("close", () => { sockets.delete(res); });
  void (async (): Promise<void> => {
    const parts: Buffer[] = [];
    for await (const part of req) {
      parts.push(Buffer.isBuffer(part) ? part : Buffer.from(String(part)));
    }
    const body = asRecord(JSON.parse(Buffer.concat(parts).toString("utf8"))) ?? {};
    requests.push(body);
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const planTool = tools.map((tool: unknown) => asRecord(tool)).find((tool) => tool?.name === "update_plan") ?? null;
    if (planTool !== null && toolDefinitions.length === 0) {
      toolDefinitions.push(planTool);
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    let sequence = 0;
    const send = (type: string, fields: Record<string, unknown>): void => {
      if (!res.destroyed) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`); }
    };
    const item = scripted(requests.length - 1);
    const response = { id: `resp-${String(requests.length)}`, object: "response", status: "completed", model: "gpt-5.1" };
    send("response.created", { response: { ...response, status: "in_progress", output: [] } });
    send("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress" } });
    if (item.type === "message") {
      const content = Array.isArray(item.content) ? item.content : [];
      const text = typeof asRecord(content[0])?.text === "string" ? String(asRecord(content[0])?.text) : "";
      send("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: text });
      send("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text });
    }
    send("response.output_item.done", { output_index: 0, item });
    send("response.completed", { response: { ...response, output: [item], usage: { input_tokens: 40, output_tokens: 12, total_tokens: 52 } } });
    res.end();
  })();
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address !== null && typeof address !== "string");

const records: RawEvent[] = [];
const live: Event[] = [];
const frames: JsonRecord[] = [];
await writeFile(path.join(home, "config.toml"), [
  'model = "gpt-5.1"', 'model_provider = "probe"', 'preferred_auth_method = "apikey"',
  "[tools.update_plan]", "enabled = true", "",
  "[model_providers.probe]", 'name = "probe"',
  `base_url = "http://127.0.0.1:${String(address.port)}/v1"`, 'env_key = "OPENAI_API_KEY"', 'wire_api = "responses"',
].join("\n"));

const session = await runtime.session(detected, {
  cwd: home,
  model: "gpt-5.1",
  env: { CODEX_HOME: home, OPENAI_API_KEY: "local-probe-placeholder" },
});
session.rawEvents((record) => { records.push(record); });
session.events((event) => { live.push(event); });

async function until(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out: ${description}`);
    // Each observation depends on the previous predicate result.
    // oxlint-disable-next-line eslint/no-await-in-loop
    await delay(20);
  }
}

try {
  const ends = (): number => records.filter((record) => record.kind === "frame" && record.body.type === "turn/completed").length;
  await session.prompt("Plan the work, then report");
  await until(() => ends() >= 1, "the first turn to end");
  await session.prompt("Clear the checklist");
  await until(() => ends() >= 2, "the second turn to end");
} finally {
  await session.dispose();
}

for (const record of records) {
  if (record.kind === "frame" && record.body.type === "turn/plan/updated") {
    frames.push({ native: record.body.native, events: record.body.events, spanId: record.spanId });
  }
}
const planEvents = live.filter((event) => event.kind === "plan_changed");
const replayed = records.flatMap((record) => eventsOf(record)).filter((event) => event.kind === "plan_changed");

// Three observations, each the whole list the turn sent; the third is the model's own clear.
assert.deepEqual(planEvents.map((event) => event.plan), [
  { steps: [{ step: "Collect the native facts", status: "in_progress" }, { step: "Write the checklist spec", status: "pending" }], explanation: "Two steps to prove the wire" },
  { steps: [{ step: "Collect the native facts", status: "completed" }, { step: "Write the checklist spec", status: "completed" }] },
  { steps: [] },
]);
assert.ok(requests.some((body) => Array.isArray(body.tools) && body.tools.some((tool: unknown) => asRecord(tool)?.name === "update_plan")), "the model was offered the checklist tool");
assert.equal(frames.length, 3);
assert.equal(new Set(frames.map((frame) => frame.spanId)).size, 2, "each observation carries the turn that sent it");
assert.equal(frames[0]?.spanId, frames[1]?.spanId);
assert.notEqual(frames[2]?.spanId, frames[0]?.spanId);
// Replay reads the same facts from the records, and no plan frame became transcript text.
assert.deepEqual(replayed.map((event) => ({ plan: event.plan, evidence: event.evidence, seq: event.seq })), planEvents.map((event) => ({ plan: event.plan, evidence: event.evidence, seq: event.seq })));
assert.equal(live.some((event) => event.kind === "text_delta" && event.text.includes("Collect the native facts")), false);

const evidence = {
  at: new Date().toISOString(),
  codex: version,
  platform: `${process.platform}-${process.arch}`,
  config: { toolsUpdatePlanEnabled: true, provider: "local scripted Responses stream", model: "gpt-5.1" },
  tool: toolDefinitions[0] ?? null,
  frames,
  oarEvents: planEvents.map((event) => ({ kind: event.kind, plan: event.plan, evidence: event.evidence, spanId: event.spanId, seq: event.seq })),
};
await mkdir(out, { recursive: true });
await writeFile(path.join(out, "codex-plan-2026-11-24.json"), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ frames: frames.length, planEvents: planEvents.length, tool: evidence.tool?.parameters }, null, 1));
server.close();
for (const socket of sockets) { socket.destroy(); }
await rm(home, { recursive: true, force: true });
