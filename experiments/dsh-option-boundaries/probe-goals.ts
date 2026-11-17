import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { say, withDshFixture } from "../../sea-trial/vendor/support/dsh-fixture.js";
import { withNativeProbe } from "./native-probe.js";

const output = path.resolve(process.argv[2] ?? "oar-trial-run/dsh-goals.json");
const root = "11111111-1111-4111-8111-111111111111";
const peer = "22222222-2222-4222-8222-222222222222";
const calls: JsonRecord[] = [];
const source = `probe(request) {
  const { agent } = owned(request.sessionId);
  const goals = ctx.get("goals");
  const current = goals.get(agent);
  if (request.op === "get") return { goal: current ?? null };
  if (request.op === "create") return { goal: goals.create(agent, request.options) };
  if (request.op === "edit") return { goal: goals.edit(agent, current, request.options) };
  if (request.op === "clear") return { ref: goals.clear(agent, current), goal: goals.get(agent) ?? null };
  if (request.op === "block") return { goal: goals.block(agent, current, { code: "probe-block", message: "Synthetic control" }) };
  return { goal: goals[request.op](agent, current) };
},`;
await withDshFixture(() => say("goal probe"), async (fixture) => {
  assert.ok(fixture.installation.via === "executable");
  const raw: JsonRecord = { version: fixture.installation.version ?? "unknown", calls };
  try {
    await withNativeProbe(fixture, { source, rows: [{ id: "goal-round-driver", disabled: true }] }, async (control, frames) => {
      raw.frames = frames;
      await control.request("open", { sessionId: root, cwd: fixture.aimock.cwd });
      await control.request("open", { sessionId: peer, cwd: fixture.aimock.cwd });
      const run = async (op: string, options?: JsonRecord, sessionId = root): Promise<unknown> => {
        const result = await control.request("probe", { sessionId, op, ...(options === undefined ? {} : { options }) });
        calls.push({ op, sessionId, result }); return result.goal;
      };
      assert.equal(await run("get"), null);
      const created = asRecord(await run("create", { objective: "Synthetic goal" }));
      assert.ok(created !== null);
      assert.equal(created.phase, "active");
      assert.equal(created.activation, "armed");
      assert.ok(typeof created.maxGoalRounds === "number");
      assert.equal(created.tokenBudget, undefined);
      assert.equal(await run("get", undefined, peer), null);
      assert.equal(asRecord(await run("pause"))?.phase, "paused");
      assert.equal(asRecord(await run("edit", { objective: "Edited goal" }))?.objective, "Edited goal");
      assert.equal(asRecord(await run("resume"))?.phase, "active");
      assert.equal(asRecord(await run("block"))?.phase, "blocked");
      assert.equal(asRecord(await run("resume"))?.phase, "active");
      assert.equal(asRecord(await run("complete"))?.phase, "complete");
      assert.equal(await run("clear"), null);
      await run("create", { objective: "Saved paused goal" });
      await run("pause");
    });
    await withNativeProbe(fixture, { source, rows: [{ id: "goal-round-driver", disabled: true }] }, async (control, frames) => {
      raw.resumeFrames = frames;
      await control.request("resume", { sessionId: root });
      const resumed = await control.request("probe", { sessionId: root, op: "get" });
      calls.push({ op: "resumed-get", result: resumed });
      assert.equal(asRecord(resumed.goal)?.objective, "Saved paused goal");
      assert.equal(asRecord(resumed.goal)?.phase, "paused");
      assert.equal(asRecord(resumed.goal)?.activation, "disarmed");
    });
    raw.passed = true;
  } finally {
    raw.requests = fixture.provider.requests;
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(raw, null, 2));
  }
});
console.log(JSON.stringify({ output, passed: true, calls: calls.length }));
