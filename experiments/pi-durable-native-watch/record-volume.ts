import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { applyImmutable, assertValidOp } from "@earendil-works/chord/delta";
import type { ConversationView } from "@earendil-works/pi-durable";
import { startDurableFixture } from "../../sea-trial/harness/pi-durable.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";

// A separate local artifact directory retains full records; commit only the measured summary.
const [directory, suppliedFormat] = process.argv.slice(2);
assert.ok(directory !== undefined && directory !== "", "Provide a fresh output directory");
const format = suppliedFormat ?? "deltas";
assert.ok(format === "deltas" || format === "with-values");
await mkdir(directory, { recursive: false });
const fixture = await startDurableFixture(mock => { mock.onMessage(/.*/u, { content: "ok" }); });
const observed: ConversationView[] = [];
const observe = fixture.harness.observeConversation.bind(fixture.harness);
fixture.harness.observeConversation = async (...args): ReturnType<typeof observe> => {
  const [id, observer, context, window] = args;
  const result = await observe(id, { ...observer, advance(...update) { const [call] = update; if (call.kind === "value") { observed.push(call.value); } observer.advance(...update); } }, context, window);
  observed.unshift(result.value);
  return result;
};
const session = await fixture.runtime.session({ kind: "available", via: "bundled" }, { cwd: "/virtual", model: "aimock/aimock-model" });
try {
  for (let index = 0; index < 30; index += 1) {
    // oxlint-disable-next-line no-await-in-loop -- Each measured prompt must finish before the next starts.
    const result = await promptAndWait(session, `round ${String(index + 1)}`);
    assert.equal(result.kind, "ended");
    assert.deepEqual(result.outcome, { kind: "completed" });
  }
  await fixture.harness.waitForIdle(BACKGROUND_CONTEXT);
  await session.dispose();
  const records = session.records();
  const views = records.flatMap(record => record.kind === "frame" && (record.body.type === "snapshot" || record.body.type === "pi-durable/view") ? [record.body] : []);
  let value: unknown = views[0]?.native;
  assert.deepEqual(value, observed[0]);
  for (const [index, frame] of views.slice(1).entries()) {
    const { native } = frame;
    assert.ok(typeof native === "object" && native !== null && "ops" in native && Array.isArray(native.ops));
    const ops: unknown[] = native.ops;
    value = applyImmutable(value, ops.map(op => { assertValidOp(op); return op; }));
    assert.deepEqual(value, observed[index + 1]);
    assert.deepEqual(Object.keys(native).toSorted(), format === "deltas" ? ["ops", "retired"] : ["kind", "ops", "retired", "value"]);
  }
  assert.equal(views.length, observed.length);
  const jsonl = `${records.map(record => JSON.stringify(record)).join("\n")}\n`;
  const summary = { prompts: 30, format, records: records.length, viewFrames: views.length, replayedRevisions: observed.length, jsonlBytes: Buffer.byteLength(jsonl) };
  await writeFile(path.join(directory, "records.jsonl"), jsonl);
  await writeFile(path.join(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary));
} finally { await session.dispose(); await fixture.close(); }
