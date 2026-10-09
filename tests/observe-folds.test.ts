import assert from "node:assert/strict";
import { test } from "vitest";
import type { AdapterSession, ControlResult, FrameBody, RuntimeEventBody, RawEvent, TurnOutcome } from "../packages/oar/src/index.js";
import { awaitTurnEnd, turnEndAfter } from "../packages/oar/src/observe/turns.js";
import { contextUsageOf, effortOf, modelOf, serviceTierOf, usageOf } from "../packages/oar/src/observe/usage.js";
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

function usage(input: number, output: number): RuntimeEventBody {
  return { kind: "usage", usage: { context: { tokens: input, contextWindow: null, percent: null }, tokens: { input, output } } };
}

function sessionOver(kernel: SessionKernel): AdapterSession {
  const control = async (body: ControlResult["request"]["body"]): Promise<ControlResult> =>
    kernel.control(body, () => ({ kind: "accepted" }));
  return {
    id: kernel.sessionId,
    capabilities: { queue: { durable: false }, attribution: "nested", images: false },
    prompt: async (input) => control({ kind: "prompt", input }),
    steer: async (input) => control({ kind: "steer", input }),
    queue: async (input) => control({ kind: "queue", input }),
    abort: async () => control({ kind: "abort" }),
    rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
    records: () => kernel.records(),
    graph: () => kernel.graph(),
    dispose: async () => {},
  };
}

function turnEnded(outcome: TurnOutcome): FrameBody {
  return { type: "turn/completed", native: {}, events: [{ kind: "turn_ended", outcome }] };
}

/** A child session (own sessionId, agentPath []) reports its turn end; the root's prompt is still open. */
function childTurnEndsFirst(kernel: SessionKernel, afterSeq: number): void {
  kernel.link({ parent: ROOT, child: CHILD, via: "tool_call" });
  const childEnd = kernel.frame(turnEnded({ kind: "completed" }), { sessionId: CHILD });
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

  kernel.frame(turnEnded({ kind: "aborted" }));
  assert.deepEqual(await waiting, { kind: "aborted" }, "it resolves on the root session's own turn end");
});

/** Root and child each report a model and a cumulative usage figure; the child's live in the child's records. */
function rootAndChildReport(kernel: SessionKernel): void {
  kernel.frame({ type: "thread/start", native: {}, events: [{ kind: "model", model: "root-model" }] });
  kernel.frame({ type: "thread/tokenUsage/updated", native: {}, events: [usage(100, 10)] });
  kernel.link({ parent: ROOT, child: CHILD, via: "tool_call" });
  kernel.frame({ type: "thread/start", native: {}, events: [{ kind: "model", model: "child-model" }] }, { sessionId: CHILD });
  kernel.frame({ type: "thread/tokenUsage/updated", native: {}, events: [usage(500, 50)] }, { sessionId: CHILD });
}

function assertChildFoldsByItsOwnId(records: readonly RawEvent[]): void {
  assert.equal(modelOf(records, CHILD).value, "child-model", "the child's own answers are in its own records");
  assert.deepEqual(usageOf(records, CHILD).value, { total: { input: 500, output: 50 } });
  assert.deepEqual(contextUsageOf(records, CHILD).value, { tokens: 500, contextWindow: null, percent: null });
  assert.deepEqual(usageOf(records).value, { total: { input: 500, output: 50 } }, "unscoped, both sessions collide on agentPath []: the reason the Session folds are scoped");
}

function assertRootReadbackSeqs(session: ReturnType<typeof sealSession>): void {
  assert.equal(session.model().seq, 1, "model fold rests on the last root record consumed");
  assert.equal(session.usage().seq, 3, "usage fold rests on the last record consumed, the derived child's included (withChildren)");
  assert.equal(session.contextUsage().seq, 1, "context fold rests on the last root record consumed");
}

// effort() is the runtime's own report, like model(): the latest root
// `effort` event, scoped to the root session (a child thread or child session
// runs its own level), null before any, and never the request echoed.
test("effort folds the latest root effort report and ignores a child session's", () => {
  const kernel = createSessionKernel(ROOT);
  const session = sealSession(sessionOver(kernel));
  assert.deepEqual(session.effort(), { value: null, seq: -1 }, "null before the runtime said anything");
  kernel.frame({ type: "thread/start", native: {}, events: [{ kind: "model", model: "root-model" }, { kind: "effort", effort: "low" }] });
  kernel.frame({ type: "thread/start", native: {}, events: [{ kind: "effort", effort: "xhigh" }] }, { sessionId: CHILD });
  assert.deepEqual(session.effort(), { value: "low", seq: 0 });
  kernel.frame({ type: "thread/settings/updated", native: {}, events: [{ kind: "effort", effort: "high" }] });
  assert.deepEqual(session.effort(), { value: "high", seq: 2 });
  assert.equal(effortOf(session.records(), CHILD).value, "xhigh", "the child's own report is in its own records");
});

test("model, usage and contextUsage fold only the root session's records", () => {
  const kernel = createSessionKernel(ROOT);
  const session = sealSession(sessionOver(kernel));
  rootAndChildReport(kernel);

  assert.equal(session.model().value, "root-model");
  assert.deepEqual(session.usage().value, { total: { input: 100, output: 10 }, withChildren: { input: 600, output: 60 } }, "the child's cumulative figure neither overwrites nor joins the root's; withChildren adds it");
  assert.deepEqual(session.contextUsage().value, { tokens: 100, contextWindow: null, percent: null });
  assertRootReadbackSeqs(session);
  assertChildFoldsByItsOwnId(session.records());

  kernel.frame({ type: "thread/tokenUsage/updated", native: {}, events: [usage(120, 12)] }, { agentPath: ["worker"] });
  assert.deepEqual(session.usage().value, {
    total: { input: 220, output: 22 },
    byAgent: [
      { agentPath: [], tokens: { input: 100, output: 10 } },
      { agentPath: ["worker"], tokens: { input: 120, output: 12 } },
    ],
    withChildren: { input: 720, output: 72 },
  }, "sub-agents of this session (agentPath) still aggregate");
});

// #282: what this session spent with everything it derived, counted by OAR so
// a host need not know whether a runtime's parent total includes its children
// (codex child threads, grok child sessions and OpenCode v2 children never do).
// SYNTHETIC frames, codex-shaped as above.
function reports(kernel: SessionKernel, sessionId: string, [input, output]: readonly [number, number]): void {
  kernel.frame({ type: "thread/tokenUsage/updated", native: {}, events: [usage(input, output)] }, sessionId === ROOT ? {} : { sessionId });
}

/** Two children of the root share one grandchild (a diamond), and one id on the wire has no edge from the root. */
function family(): ReturnType<typeof sealSession> {
  const kernel = createSessionKernel(ROOT);
  for (const [parent, child] of [[ROOT, "a"], [ROOT, "b"], ["a", "c"], ["b", "c"]] as const) {
    kernel.link({ parent, child, via: "tool_call" });
  }
  kernel.node("stray");
  // Each session's running total is its latest report: a's 20 is replaced by its 30.
  const reported = [[ROOT, [100, 10]], ["a", [20, 2]], ["b", [3, 1]], ["c", [7, 1]], ["a", [30, 3]], ["stray", [1000, 100]]] as const;
  for (const [sessionId, counts] of reported) {
    reports(kernel, sessionId, counts);
  }
  return sealSession(sessionOver(kernel));
}

test("withChildren is absent until a derived child session reports, and a child that has not reported adds nothing", () => {
  const kernel = createSessionKernel(ROOT);
  const session = sealSession(sessionOver(kernel));
  reports(kernel, ROOT, [100, 10]);
  kernel.link({ parent: ROOT, child: "a", via: "tool_call" });
  kernel.link({ parent: ROOT, child: "b", via: "tool_call" });
  assert.equal(session.usage().value.withChildren, undefined);
  reports(kernel, "a", [20, 2]);
  assert.deepEqual(session.usage().value, { total: { input: 100, output: 10 }, withChildren: { input: 120, output: 12 } });
});

test("withChildren adds every derived child session's total once, nested ones too, and nothing outside the graph", () => {
  const session = family();
  assert.deepEqual(session.usage().value, { total: { input: 100, output: 10 }, withChildren: { input: 140, output: 15 } }, "a 30, b 3 and c 7 once each; stray is not derived from the root");
  assert.deepEqual(usageOf(session.records(), "a", session.graph()).value, { total: { input: 30, output: 3 }, withChildren: { input: 37, output: 4 } }, "a child's own answer adds its own descendants");
  assert.deepEqual(usageOf(session.records(), ROOT).value, { total: { input: 100, output: 10 } }, "without the graph, the session alone");
});

test("withChildren is absent while the session's own total is unknown", () => {
  const kernel = createSessionKernel(ROOT);
  const session = sealSession(sessionOver(kernel));
  // A resumed codex thread without a baseline: context only, no tokens.
  kernel.frame({ type: "thread/tokenUsage/updated", native: {}, events: [{ kind: "usage", usage: { context: { tokens: 10, contextWindow: null, percent: null } } }] });
  kernel.link({ parent: ROOT, child: CHILD, via: "tool_call" });
  kernel.frame({ type: "thread/tokenUsage/updated", native: {}, events: [usage(500, 50)] }, { sessionId: CHILD });
  assert.deepEqual(session.usage().value, { total: null });
});

// #282: a runtime's own session total (claude's modelUsage) beyond its
// agents' figures: the total is the runtime's, the rest unattributed.
test("a reported session total is the total; what no agent accounts for is unattributed", () => {
  const kernel = createSessionKernel(ROOT);
  const session = sealSession(sessionOver(kernel));
  kernel.frame({ type: "result", native: {}, events: [{ kind: "usage", usage: { tokens: { input: 100, output: 10, cacheRead: 60, cacheWrite: 30 }, total: { input: 100, output: 10, cacheRead: 60, cacheWrite: 30 } } }] });
  assert.deepEqual(session.usage().value, { total: { input: 100, output: 10, cacheRead: 60, cacheWrite: 30 } }, "all of it the root's: no breakdown");
  kernel.frame({ type: "result", native: {}, events: [{ kind: "usage", usage: { tokens: { input: 150, output: 15, cacheRead: 80, cacheWrite: 40 }, total: { input: 400, output: 25, cacheRead: 200, cacheWrite: 90 } } }] });
  assert.deepEqual(session.usage().value, {
    total: { input: 400, output: 25, cacheRead: 200, cacheWrite: 90 },
    byAgent: [{ agentPath: [], tokens: { input: 150, output: 15, cacheRead: 80, cacheWrite: 40 } }],
    unattributed: { input: 250, output: 10, cacheRead: 120, cacheWrite: 50 },
  });
  // A later frame without a session total keeps the last one.
  kernel.frame({ type: "result", native: {}, events: [{ kind: "usage", usage: { context: { tokens: 1, contextWindow: null, percent: null } } }] });
  assert.deepEqual(session.usage().value.total, { input: 400, output: 25, cacheRead: 200, cacheWrite: 90 });
});


function tokens(body: { input: number; output: number; cacheRead?: number; cacheWrite?: number }): FrameBody {
  return { type: "result", native: {}, events: [{ kind: "usage", usage: { tokens: body } }] };
}

// #161: cacheRead / cacheWrite sum over the agents the way input does, each
// part over the agents that reported it; an agent that reported none adds
// nothing, and a part no agent reported is absent from the total.
test("usage totals sum each cache part over the agents that reported it", () => {
  const kernel = createSessionKernel(ROOT);
  const session = sealSession(sessionOver(kernel));
  kernel.frame(tokens({ input: 100, output: 10, cacheRead: 60, cacheWrite: 30 }));
  assert.deepEqual(session.usage().value, { total: { input: 100, output: 10, cacheRead: 60, cacheWrite: 30 } });
  kernel.frame(tokens({ input: 40, output: 4, cacheRead: 25 }), { agentPath: ["worker"] });
  kernel.frame(tokens({ input: 9, output: 1 }), { agentPath: ["reader"] });
  assert.deepEqual(session.usage().value, {
    total: { input: 149, output: 15, cacheRead: 85, cacheWrite: 30 },
    byAgent: [
      { agentPath: [], tokens: { input: 100, output: 10, cacheRead: 60, cacheWrite: 30 } },
      { agentPath: ["worker"], tokens: { input: 40, output: 4, cacheRead: 25 } },
      { agentPath: ["reader"], tokens: { input: 9, output: 1 } },
    ],
  });
  const plain = createSessionKernel(ROOT);
  plain.frame(tokens({ input: 9, output: 1 }));
  assert.deepEqual(usageOf(plain.records()).value, { total: { input: 9, output: 1 } }, "no agent reported a cache part: none in the total");
});


test("service tier is unknown until the runtime reports it", () => {
  const kernel = createSessionKernel(ROOT);
  const session = sealSession(sessionOver(kernel));
  assert.deepEqual(session.serviceTier(), { value: null, seq: -1 });
});

test("service tier folds root reports, including default, and survives replay", () => {
  const kernel = createSessionKernel(ROOT);
  const session = sealSession(sessionOver(kernel));
  kernel.frame({ type: "thread/start", native: {}, events: [{ kind: "service_tier", serviceTier: "priority" }] });
  for (const scope of [{ sessionId: CHILD }, { agentPath: ["subagent"] }]) {
    kernel.frame({ type: "child", native: {}, events: [{ kind: "service_tier", serviceTier: "flex" }] }, scope);
  }
  assert.deepEqual(session.serviceTier(), { value: "priority", seq: 2 });
  kernel.frame({ type: "thread/settings/updated", native: {}, events: [{ kind: "service_tier", serviceTier: "default" }] });
  assert.deepEqual(session.serviceTier(), { value: "default", seq: 3 });
  const records = structuredClone(session.records());
  assert.deepEqual(serviceTierOf(records, ROOT), session.serviceTier());
});
