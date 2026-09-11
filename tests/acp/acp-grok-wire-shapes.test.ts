import assert from "node:assert/strict";
import { test } from "vitest";
import type { EventRecord } from "../../packages/oar/src/contracts/session.js";
import { awaitTurnEnd, promptAndWait } from "../../packages/oar/src/observe/turns.js";
import {
  GROK_EXTENSION_NOTIFICATIONS,
  grokContextUsage,
  grokPromptTokens,
} from "../../packages/oar/src/runtimes/grok/session.js";
import { acpLineageOf } from "../../packages/oar/src/shared/acp/records.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { describe, start } from "../fixtures/acp-session-support.js";

// Frames as grok 1.0.25 (f7e67d6988e2) sent them on 2026-09-11, tapped below
// the ACP SDK (experiments/grok-wire-tap.ts → oar-trial-run/live-grok-tap/
// wire.jsonl) and recorded in oar-trial-run/live-grok-c/subagent.voyage.jsonl
// (seqs 52, 54, 121) and live-grok-a/basic.voyage.jsonl (seq 49); ids
// shortened, signatures dropped.
const PARENT = "01a08f46-34e0-7480-a07c-c11300ff7f7f";
const CHILD = "01a08f46-deb8-7fb1-85aa-73d96c437da7";

test("grok lineage: subagent_spawned / subagent_progress name the pair snake_case under `update`", () => {
  const spawned = {
    sessionId: PARENT,
    update: {
      sessionUpdate: "subagent_spawned",
      subagent_id: CHILD,
      attempt_id: "at1.a3ea6e36f3bf4a0aa6825795cc27794a",
      parent_session_id: PARENT,
      parent_prompt_id: "c088ff51-053d-4e9a-a801-ba1ae504ba2a",
      child_session_id: CHILD,
      subagent_type: "general-purpose",
      description: "Echo CHILD-OK-7731",
      effective_context_source: "new",
      model: "grok-4.6",
    },
  };
  assert.deepEqual(acpLineageOf(spawned), { parent: PARENT, child: CHILD });
  const progress = { sessionId: PARENT, update: { sessionUpdate: "subagent_progress", subagent_id: CHILD, parent_session_id: PARENT, child_session_id: CHILD, turn_count: 1 } };
  assert.deepEqual(acpLineageOf(progress), { parent: PARENT, child: CHILD });
});

test("grok lineage: subagent_finished names only the child; the parent is the envelope's session", () => {
  const finished = {
    sessionId: PARENT,
    update: { sessionUpdate: "subagent_finished", subagent_id: CHILD, child_session_id: CHILD, status: "completed", output: "CHILD-OK-7731", will_wake: false },
    _meta: { eventId: `${PARENT}-100`, agentTimestampMs: 1_789_110_195_312 },
  };
  assert.deepEqual(acpLineageOf(finished), { parent: PARENT, child: CHILD });
});

test("lineage is never fabricated: no pair, a self pair, or a vendor kind without ids yields null", () => {
  assert.equal(acpLineageOf({ sessionId: PARENT, update: { sessionUpdate: "model_changed", model_id: "grok-4.6" } }), null);
  assert.equal(acpLineageOf({ sessionId: PARENT, update: { sessionUpdate: "turn_completed", prompt_id: "p", stop_reason: "end_turn" } }), null);
  assert.equal(acpLineageOf({ sessionId: PARENT, update: { child_session_id: PARENT } }), null);
  assert.equal(acpLineageOf({ upserted: [{ sessionId: PARENT }], removed: [] }), null);
  // The flat camelCase spelling (fixture / earlier assumption) still links.
  assert.deepEqual(acpLineageOf({ parentSessionId: "p", sessionId: "c", kind: "spawned" }), { parent: "p", child: "c" });
});

test("grok prompt answer: `_meta.usage` is the prompt's ledger, `_meta.totalTokens` the context count", () => {
  const answer = {
    stopReason: "end_turn",
    _meta: {
      sessionId: PARENT,
      promptId: "bc31f0cd-83fd-44e1-a24f-e48ad481647c",
      totalTokens: 16_825,
      modelId: "grok-4.6",
      inputTokens: 16_791,
      outputTokens: 34,
      cachedReadTokens: 1280,
      reasoningTokens: 28,
      usage: { inputTokens: 16_791, outputTokens: 34, totalTokens: 16_825, cachedReadTokens: 1280, cacheCreationTokens: 0, reasoningTokens: 28, modelCalls: 1 },
    },
  };
  assert.deepEqual(grokPromptTokens(answer), { input: 16_791, output: 34 });
  assert.deepEqual(grokContextUsage(answer), { tokens: 16_825, contextWindow: null, percent: null });
  assert.equal(grokPromptTokens({ stopReason: "end_turn" }), null);
  assert.equal(grokPromptTokens({ stopReason: "cancelled", _meta: { totalTokens: 5 } }), null);
  // A half ledger is no ledger: the missing side is never invented as 0.
  assert.equal(grokPromptTokens({ stopReason: "end_turn", _meta: { usage: { inputTokens: 12 } } }), null);
  assert.equal(grokPromptTokens({ stopReason: "end_turn", _meta: { usage: { outputTokens: 3, modelCalls: 1 } } }), null);
});

const grokProfile = {
  extensionNotifications: GROK_EXTENSION_NOTIFICATIONS,
  promptContextUsage: grokContextUsage,
  promptTokenUsage: grokPromptTokens,
};

// oxlint-disable-next-line eslint/max-statements -- one child spawn, asserted end to end.
test("a grok child session gets its graph edge from the vendor session_notification, and its records keep their own id", async () => {
  const session = await start(grokProfile);
  const run = await promptAndWait(session, "spawn-child-grok");
  assert.equal(run.kind, "ended");
  assert.deepEqual(session.graph().nodes.map((node) => node.id), ["fake-session", "fake-child-grok"]);
  assert.deepEqual(session.graph().edges, [{ parent: "fake-session", child: "fake-child-grok", via: "tool_call" }]);
  const vendor = session.records().filter((record) => record.kind === "event" && record.body.type === "_x.ai/session_notification");
  assert.equal(vendor.length, 5, "spawned, progress, the child's response_completed + turn_completed, finished: each recorded verbatim");
  const lifecycle = vendor.filter((record) => record.sessionId === "fake-session");
  assert.deepEqual(
    lifecycle.map((record) => (record.kind === "event" ? asRecord(asRecord(record.body.native)?.update)?.sessionUpdate : null)),
    ["subagent_spawned", "subagent_progress", "subagent_finished"],
    "a frame that names a child but carries the parent's envelope is the parent's",
  );
  for (const record of vendor) {
    assert.ok(record.kind === "event");
    assert.deepEqual(record.body.views, []);
  }
  const [spawned] = lifecycle;
  assert.ok(spawned?.kind === "event");
  assert.deepEqual(spawned.body.native, {
    sessionId: "fake-session",
    update: { sessionUpdate: "subagent_spawned", subagent_id: "fake-child-grok", parent_session_id: "fake-session", child_session_id: "fake-child-grok", subagent_type: "general-purpose", description: "Echo", model: "fixture-model-x" },
  });
  // The child's own frames (standard updates AND the vendor ledgers whose
  // envelope names the child, live seqs 78, 119, 120) carry the child's id.
  const child = session.records().filter((record) => record.sessionId === "fake-child-grok");
  assert.deepEqual(child.map((record) => describe(record)), [
    "event user_message_chunk",
    "event agent_message_chunk → text:child-says-hi",
    "event _x.ai/session_notification",
    "event _x.ai/session_notification",
  ]);
  assert.deepEqual(
    child.slice(2).map((record) => (record.kind === "event" ? asRecord(record.body.native) : null)),
    [
      { sessionId: "fake-child-grok", update: { sessionUpdate: "response_completed", usage: { input_tokens: 80, output_tokens: 8, cache_read_input_tokens: 0 } } },
      { sessionId: "fake-child-grok", update: { sessionUpdate: "turn_completed", prompt_id: "child-prompt", stop_reason: "end_turn", usage: { inputTokens: 80, outputTokens: 8, totalTokens: 88, modelCalls: 1 } } },
    ],
  );
  assert.ok(child.every((record) => record.agentPath.length === 0));
  // The root's prompt ledger already sums the child's calls (live seq 159);
  // the child's own ledgers are native-only and never folded a second time.
  assert.deepEqual(session.usage(), { total: { input: 200, output: 20 } });
  assert.deepEqual(session.contextUsage(), { tokens: 300, contextWindow: null, percent: null });
  await session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- two turns, the fold after each, and both stamped views.
test("grok per-prompt ledgers accumulate into the session total, stamped cumulative on each answer", async () => {
  const session = await start(grokProfile);
  const first = await promptAndWait(session, "grok-usage");
  assert.equal(first.kind, "ended");
  assert.deepEqual(session.usage(), { total: { input: 100, output: 7 } });
  const second = await promptAndWait(session, "grok-usage");
  assert.equal(second.kind, "ended");
  assert.deepEqual(session.usage(), { total: { input: 200, output: 14 } });
  assert.deepEqual(session.contextUsage(), { tokens: 1002, contextWindow: null, percent: null });
  const answers = session.records().flatMap((record) => (record.kind === "event" && record.body.type === "session/prompt" ? [record.body.views] : []));
  assert.deepEqual(answers, [
    [{ kind: "turn_ended", outcome: { kind: "completed" } }, { kind: "usage", usage: { context: { tokens: 1001, contextWindow: null, percent: null }, tokens: { input: 100, output: 7 } } }],
    [{ kind: "turn_ended", outcome: { kind: "completed" } }, { kind: "usage", usage: { context: { tokens: 1002, contextWindow: null, percent: null }, tokens: { input: 200, output: 14 } } }],
  ]);
  await session.dispose();
});

const QUEUE_CHANGED = { sessionId: "fake-session", entries: [{ id: "queue-1", version: 0, kind: "prompt", text: "grok-usage", position: 0 }] };

async function queueChangedRecords(profile: Parameters<typeof start>[0]): Promise<readonly EventRecord[]> {
  const session = await start(profile);
  const run = await promptAndWait(session, "grok-usage");
  assert.equal(run.kind, "ended");
  await session.dispose();
  return session.records().filter((record): record is EventRecord => record.kind === "event" && record.body.type === "_x.ai/queue/changed");
}

test("a listed vendor method (`_x.ai/queue/changed`) reaches the stream verbatim under the root", async () => {
  const [queue, ...rest] = await queueChangedRecords(grokProfile);
  assert.ok(queue !== undefined && rest.length === 0);
  assert.deepEqual(queue.body, { type: "_x.ai/queue/changed", native: QUEUE_CHANGED, views: [] });
  assert.equal(queue.sessionId, "fake-session");
});

test("the same push on an unlisted method is a frame oar never sees (the SDK discards it before any handler)", async () => {
  assert.deepEqual(await queueChangedRecords({ promptContextUsage: grokContextUsage, promptTokenUsage: grokPromptTokens }), []);
});

// live-grok-b/steer.voyage.jsonl: the cancelled answer (seq 63) bills its one
// model call (16776/222), the closing answer (seq 158) ITS OWN two calls
// (34420/279, `modelCalls: 2`): two per-prompt ledgers, so the session sum
// is 51196/501 and neither call is counted twice.
test("a send-now steer's two answers are two per-prompt ledgers: summed once, stamped cumulative", async () => {
  const session = await start({ ...grokProfile, steerParams: () => ({ _meta: { sendNow: true } }) });
  const base = await session.prompt("grok-steer-base");
  assert.equal(base.response.body.kind, "accepted");
  const steered = await session.steer("grok-steer-new");
  assert.equal(steered.response.body.kind, "accepted");
  assert.deepEqual(await awaitTurnEnd(session, base.request.seq), { kind: "completed" });
  const answers = session.records().flatMap((record) => (record.kind === "event" && record.body.type === "session/prompt" ? [record.body.views] : []));
  assert.deepEqual(answers, [
    [{ kind: "usage", usage: { context: { tokens: 16_998, contextWindow: null, percent: null }, tokens: { input: 16_776, output: 222 } } }],
    [{ kind: "turn_ended", outcome: { kind: "completed" } }, { kind: "usage", usage: { context: { tokens: 17_405, contextWindow: null, percent: null }, tokens: { input: 51_196, output: 501 } } }],
  ]);
  assert.deepEqual(session.usage(), { total: { input: 51_196, output: 501 } });
  await session.dispose();
});
