/**
 * Does Grok's will_wake identify child spend absent from the parent ledger?
 * OAR_GROK_BIN=/path/to/grok pnpm tsx experiments/grok-background-usage.ts
 * Uses an isolated home and scripted local provider; no account or quota.
 */
/* oxlint-disable import/max-dependencies -- Native probe combines adapter, provider harness and filesystem evidence. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChatCompletionRequest } from "@copilotkit/aimock";
import type { RawEvent, Session } from "../packages/oar/src/contracts/session.js";
import { promptAndWait } from "../packages/oar/src/observe/turns.js";
import { grokSession } from "../packages/oar/src/runtimes/grok/session.js";
import { asRecord } from "../packages/oar/src/shared/json.js";
import { runExecutable } from "../packages/oar/src/shared/executable/run.js";
import { startGrokAimock } from "../sea-trial/harness/aimock-acp.js";

const expectedTotals = {
  foreground: { input: 2810, output: 31 },
  "background-child-first": { input: 2820, output: 32 },
  "background-parent-first": { input: 2120, output: 25 },
};
type Scenario = keyof typeof expectedTotals;
const command = process.env.OAR_GROK_BIN ?? "grok";
const output = path.resolve(process.env.OAR_PROBE_DIR ?? "oar-trial-run/grok-background-usage");
const version = await runExecutable(command, ["--version"]);
assert.equal(version.ok, true, version.stderr);
await mkdir(output, { recursive: true });

function lastText(request: ChatCompletionRequest): string {
  const content = request.messages.at(-1)?.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

function terminalRecords(records: readonly RawEvent[]): unknown[] {
  return records.flatMap((record) => {
    if (record.kind !== "frame") { return []; }
    const update = asRecord(asRecord(record.body.native)?.update);
    if (update?.sessionUpdate !== "turn_completed" && update?.sessionUpdate !== "subagent_finished" && record.body.type !== "session/prompt") { return []; }
    return [{ seq: record.seq, sessionId: record.sessionId, type: record.body.type, native: record.body.native }];
  });
}

async function run(scenario: Scenario): Promise<void> {
  const childFinished = Promise.withResolvers<void>();
  const parentFinished = Promise.withResolvers<void>();
  const wakeFinished = Promise.withResolvers<void>();
  const background = scenario !== "foreground";
  const env = await startGrokAimock((mock) => {
    mock.on({ predicate: (req) => req.messages.at(-1)?.role === "user" && lastText(req).includes("CHILD-TASK") }, async () => {
      if (scenario === "background-parent-first") { await parentFinished.promise; }
      return { content: "child-done", usage: { prompt_tokens: 700, completion_tokens: 7 } };
    });
    mock.on({ predicate: (req) => req.messages.at(-1)?.role === "user" && lastText(req).includes("SPAWN-CHILD") }, {
      toolCalls: [{ id: "call_spawn", name: "spawn_subagent", arguments: JSON.stringify({ description: "child", prompt: "CHILD-TASK: reply child-done", subagent_type: "general-purpose", background }) }],
      usage: { prompt_tokens: 1000, completion_tokens: 20 },
    });
    mock.on({ predicate: (req) => req.messages.at(-1)?.role === "tool" }, async () => {
      if (scenario === "background-child-first") { await childFinished.promise; }
      return { content: "spawned", usage: { prompt_tokens: 1100, completion_tokens: 3 } };
    });
    mock.on({ predicate: () => true }, { content: "ok", usage: { prompt_tokens: 10, completion_tokens: 1 } });
  });
  const cwd = await mkdtemp(path.join(tmpdir(), "oar-grok-usage-work-"));
  let session: Session | undefined = undefined;
  let expired = false;
  const deadline = setTimeout(() => {
    expired = true;
    childFinished.resolve(); parentFinished.resolve(); wakeFinished.resolve();
  }, 45_000);
  try {
    session = await grokSession({ kind: "available", via: "executable", command }, { cwd, env: env.env });
    const rootId = session.id;
    session.rawEvents((record) => {
      if (record.kind !== "frame") { return; }
      const update = asRecord(asRecord(record.body.native)?.update);
      if (update?.sessionUpdate === "subagent_finished") { childFinished.resolve(); }
      if (update?.sessionUpdate === "turn_completed" && record.sessionId === rootId) {
        if (String(update.prompt_id).startsWith("subagent-completed-")) { wakeFinished.resolve(); }
        else { parentFinished.resolve(); }
      }
    }, { sessionId: rootId, afterSeq: -1 });
    const first = await promptAndWait(session, "SPAWN-CHILD: start one child", { timeoutMs: 30_000 });
    assert.equal(first.kind, "ended", JSON.stringify(first));
    await childFinished.promise;
    if (background) { await wakeFinished.promise; }
    assert.equal(expired, false, `${scenario}: native completion deadline`);
    const second = await promptAndWait(session, "SECOND-PROMPT: say ok", { timeoutMs: 30_000 });
    assert.equal(second.kind, "ended", JSON.stringify(second));
    const records = session.records();
    const native = records.flatMap((record) => record.kind === "frame" && record.sessionId === rootId ? [asRecord(asRecord(record.body.native)?.update)] : []);
    const wakes = native.filter((update) => update?.sessionUpdate === "turn_completed" && String(update.prompt_id).startsWith("subagent-completed-"));
    assert.equal(wakes.length, background ? 1 : 0);
    if (background) {
      assert.equal(native.find((update) => update?.sessionUpdate === "subagent_finished")?.will_wake, true);
      assert.equal(asRecord(wakes[0]?.usage)?.inputTokens, 10);
      assert.equal(asRecord(wakes[0]?.usage)?.outputTokens, 1);
    }
    const expected = expectedTotals[scenario];
    assert.deepEqual(session.usage().value, { total: { ...expected, cacheRead: 0, cacheWrite: 0 } });
    const evidence = { scenario, version: version.stdout.trim(), usage: session.usage(), terminals: terminalRecords(records), records };
    // All provider data is synthetic; paths from the disposable environment are removed.
    const serialized = JSON.stringify(evidence, null, 2).replaceAll(cwd, "/probe/work").replaceAll(env.env.HOME ?? "not-a-path", "/probe/home");
    await writeFile(path.join(output, `${scenario}.json`), serialized);
    console.log(JSON.stringify({ scenario, version: version.stdout.trim(), total: session.usage().value.total, spontaneousTurns: wakes.length }));
  } finally {
    clearTimeout(deadline);
    childFinished.resolve(); parentFinished.resolve(); wakeFinished.resolve();
    await session?.dispose();
    await env.stop();
    await rm(cwd, { recursive: true, force: true });
  }
}

await run("foreground");
await run("background-child-first");
await run("background-parent-first");
