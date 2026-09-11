import assert from "node:assert/strict";
import { test } from "vitest";
import type { AdapterSession, ControlResult, EventBody, EventView, SessionRecord, TurnOutcome } from "../packages/oar/src/index.js";
import { awaitTurnEnd, turnEndAfter } from "../packages/oar/src/observe/turns.js";
import { contextUsageOf, modelOf, usageOf } from "../packages/oar/src/observe/usage.js";
import { sealSession } from "../packages/oar/src/shared/seal-session.js";
import { createSessionKernel, type SessionKernel } from "../packages/oar/src/shared/session-kernel.js";

/**
 * The Session folds scope to the ROOT SESSION. Pinned by a live codex 0.149.0
 * observation (experiments/codex-child-threads.ts): a spawned child thread's
 * notifications arrive on the parent's connection as derived child-session
 * records (own `sessionId`, `agentPath []`), its `turn/completed` reached the
 * stream BEFORE the root's, and both threads report cumulative
 * `thread/tokenUsage/updated`. Without the scope the child's turn end
 * resolved `awaitTurnEnd` and the child's usage overwrote the root's.
 */

const ROOT = "root-thread";
const CHILD = "child-thread";

function usage(input: number, output: number): EventView {
  return { kind: "usage", usage: { context: { tokens: input, contextWindow: null, percent: null }, tokens: { input, output } } };
}

function sessionOver(kernel: SessionKernel): AdapterSession {
  const control = async (body: ControlResult["request"]["body"]): Promise<ControlResult> =>
    kernel.control(body, () => ({ kind: "accepted" }));
  return {
    id: kernel.sessionId,
    capabilities: { steer: false, queue: null, attribution: "nested" },
    prompt: async (input) => control({ kind: "prompt", input }),
    steer: async (input) => control({ kind: "steer", input }),
    queue: async (input) => control({ kind: "queue", input }),
    abort: async () => control({ kind: "abort" }),
    subscribe: (observer, cursor) => kernel.subscribe(observer, cursor),
    records: () => kernel.records(),
    graph: () => kernel.graph(),
    dispose: async () => {},
  };
}

function turnEnded(outcome: TurnOutcome): EventBody {
  return { type: "turn/completed", native: {}, views: [{ kind: "turn_ended", outcome }] };
}

/** A child session (own sessionId, agentPath []) reports its turn end; the root's prompt is still open. */
function childTurnEndsFirst(kernel: SessionKernel, afterSeq: number): void {
  kernel.link({ parent: ROOT, child: CHILD, via: "tool_call" });
  const childEnd = kernel.event(turnEnded({ kind: "completed" }), { sessionId: CHILD });
  assert.equal(childEnd.sessionId, CHILD);
  assert.deepEqual(childEnd.agentPath, []);
  assert.equal(turnEndAfter(kernel.records(), afterSeq, ROOT), null, "the child's turn end is not the root's");
  assert.equal(turnEndAfter(kernel.records(), afterSeq)?.kind, "completed", "unscoped, any root-agent turn end counts");
}

test("a derived child session's turn end does not end the root session's turn", async () => {
  const kernel = createSessionKernel(ROOT);
  const session = sealSession(sessionOver(kernel));
  const prompt = await session.prompt("spawn a child");
  childTurnEndsFirst(kernel, prompt.request.seq);

  let settled = false;
  const waiting = (async (): Promise<TurnOutcome> => {
    const outcome = await awaitTurnEnd(session, prompt.request.seq);
    settled = true;
    return outcome;
  })();
  await Promise.resolve();
  assert.equal(settled, false, "awaitTurnEnd is still waiting for the root session");

  kernel.event(turnEnded({ kind: "aborted" }));
  assert.deepEqual(await waiting, { kind: "aborted" }, "it resolves on the root session's own turn end");
});

/** Root and child each report a model and a cumulative usage figure; the child's live in the child's records. */
function rootAndChildReport(kernel: SessionKernel): void {
  kernel.event({ type: "thread/start", native: {}, views: [{ kind: "model", model: "root-model" }] });
  kernel.event({ type: "thread/tokenUsage/updated", native: {}, views: [usage(100, 10)] });
  kernel.link({ parent: ROOT, child: CHILD, via: "tool_call" });
  kernel.event({ type: "thread/start", native: {}, views: [{ kind: "model", model: "child-model" }] }, { sessionId: CHILD });
  kernel.event({ type: "thread/tokenUsage/updated", native: {}, views: [usage(500, 50)] }, { sessionId: CHILD });
}

function assertChildFoldsByItsOwnId(records: readonly SessionRecord[]): void {
  assert.equal(modelOf(records, CHILD), "child-model", "the child's own answers are in its own records");
  assert.deepEqual(usageOf(records, CHILD), { total: { input: 500, output: 50 } });
  assert.deepEqual(contextUsageOf(records, CHILD), { tokens: 500, contextWindow: null, percent: null });
  assert.deepEqual(usageOf(records), { total: { input: 500, output: 50 } }, "unscoped, both sessions collide on agentPath [] — the reason the Session folds are scoped");
}

test("model, usage and contextUsage fold only the root session's records", () => {
  const kernel = createSessionKernel(ROOT);
  const session = sealSession(sessionOver(kernel));
  rootAndChildReport(kernel);

  assert.equal(session.model(), "root-model");
  assert.deepEqual(session.usage(), { total: { input: 100, output: 10 } }, "the child's cumulative figure neither overwrites nor joins the root's");
  assert.deepEqual(session.contextUsage(), { tokens: 100, contextWindow: null, percent: null });
  assertChildFoldsByItsOwnId(session.records());

  kernel.event({ type: "thread/tokenUsage/updated", native: {}, views: [usage(120, 12)] }, { agentPath: ["worker"] });
  assert.deepEqual(session.usage(), {
    total: { input: 220, output: 22 },
    byAgent: [
      { agentPath: [], tokens: { input: 100, output: 10 } },
      { agentPath: ["worker"], tokens: { input: 120, output: 12 } },
    ],
  }, "sub-agents of this session (agentPath) still aggregate");
});
