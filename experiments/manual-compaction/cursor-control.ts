/** Uses a small amount of the existing Cursor login's quota. Never logs account identity. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Agent, Cursor } from "@cursor/sdk";
import { createCursorRuntime, promptAndWait } from "../../packages/oar/src/index.js";

const [output] = process.argv.slice(2); assert.ok(output !== undefined);
await mkdir(output, { recursive: true, mode: 0o700 });
const cwd = path.resolve(output, "workspace"); await mkdir(cwd, { recursive: true });
const runtime = createCursorRuntime({ sdk: async () => {
  await Promise.resolve();
  return { Agent: {
    create: async (options): Promise<Awaited<ReturnType<typeof Agent.create>>> => { const agent = await Agent.create({ ...options, tools: [] }); return agent; },
    resume: Agent.resume.bind(Agent), listRuns: Agent.listRuns.bind(Agent),
  }, Cursor };
} });
const session = await runtime.session({ kind: "available", via: "bundled" }, { cwd, model: "gpt-5.4-nano" });
assert.ok(session.compact !== undefined);
try {
  const empty = await session.compact({ timeoutMs: 30_000 });
  assert.equal(empty.kind, "rejected");
  const turn = await promptAndWait(session, "Remember SANDPIPER-823. Reply only STORED. Do not use tools.", { timeoutMs: 60_000 });
  assert.equal(turn.kind, "ended");
  const completed = await session.compact({ timeoutMs: 60_000 });
  assert.equal(completed.kind, "completed");
  assert.equal(session.status().value.kind, "idle");
  const from = session.records().length;
  let abort: ReturnType<typeof session.abort> | null = null;
  const unsubscribe = session.rawEvents(record => {
    if (record.kind === "frame" && record.body.events.some(e => e.kind === "compaction_started") && abort === null) { abort = session.abort(); }
  });
  const cancelled = await session.compact({ timeoutMs: 60_000 });
  unsubscribe();
  assert.ok(cancelled.kind === "aborted" || cancelled.kind === "completed");
  const selected = session.records().slice(from).flatMap(r => r.kind === "frame" && (r.body.type === "cursor/stream/summary" || r.body.type === "cursor/run_result") ? [{ type: r.body.type, events: r.body.events, spanId: r.spanId, native: r.body.native }] : []);
  await writeFile(path.join(output, "selected.json"), `${JSON.stringify({ sdk: "1.2.0", empty: empty.kind, completed: { kind: completed.kind, frame: completed.frame }, cancelled: cancelled.kind, selected, usage: session.usage().value }, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ empty: empty.kind, completed: completed.kind, cancelled: cancelled.kind, status: session.status().value, usage: session.usage().value }));
} finally { await session.dispose(); }
