/* oxlint-disable eslint/max-statements -- Trace replay checks spend and context as separate observations. */
import { setImmediate as settle } from "node:timers/promises";
import { expect, test } from "vitest";
import { ModelCallCompletedUpdateSchema, NestedTaskUpdateSchema } from "@cursor/sdk";
import { foldCursorDelta, initialCursorProjection } from "../../packages/oar/src/runtimes/cursor/projection.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { openFakeCursor } from "../fixtures/fake-cursor-sdk.js";
import fixture from "../../experiments/cursor-context-1.4.1/selected.json" with { type: "json" };

test("recorded 1.4.1 model calls update current context without inflating turn spend", async () => {
  const { session, agent } = await openFakeCursor();
  try {
    expect(session.contextUsage().value).toBeNull();
    const prompt = await session.prompt("recorded two-call turn");
    const run = agent.latest();
    const sample = fixture.cases.find(entry => entry.scenario === "tool-detail");
    expect(sample).toBeDefined();
    for (const event of sample?.events ?? []) {
      // Native counts are retained; the call id is synthetic and irrelevant to fullness.
      const update = { type: event.nativeType, modelCallId: `sample-${String(event.seq)}`, usage: event.usage };
      run.delta(event.nativeType === "model-call-completed" ? ModelCallCompletedUpdateSchema.parse(update) : update);
    }
    run.end("finished");
    await awaitTurnEnd(session, prompt.seq);
    expect(session.contextUsage().value).toEqual({ tokens: 13_595, contextWindow: null, percent: null });
    expect(session.usage().value).toMatchObject({ total: { input: 27_060, output: 89, cacheRead: 12_800, cacheWrite: 0 } });
  } finally { await session.dispose(); }
});

test.each([{}, { inputTokens: -1 }, { inputTokens: Number.NaN }, { inputTokens: Number.POSITIVE_INFINITY }])("missing or malformed call input stays absent: %j", usage => {
  const folded = foldCursorDelta(initialCursorProjection, { type: "model-call-completed", modelCallId: "synthetic", usage });
  expect(folded.frame.events).toEqual([]);
});

test("native zero is kept, while turn totals and step timings do not become context", () => {
  const state = initialCursorProjection;
  expect(foldCursorDelta(state, { type: "model-call-completed", usage: { inputTokens: 0 } }).frame.events).toEqual([
    { kind: "usage", usage: { context: { tokens: 0, contextWindow: null, percent: null } } },
  ]);
  expect(foldCursorDelta(state, { type: "step-completed", stepId: 1, stepDurationMs: 20 }).frame.events).toEqual([]);
  const total = foldCursorDelta(state, { type: "turn-ended", usage: { inputTokens: 100, outputTokens: 5 } });
  expect(total.frame.events).toEqual([{ kind: "usage", usage: { tokens: { input: 100, output: 5 } } }]);
});

test("completed compaction clears the old reading until a later observed native call", async () => {
  const { session, agent } = await openFakeCursor();
  try {
    const prompt = await session.prompt("work");
    const run = agent.latest();
    run.delta({ type: "model-call-completed", usage: { inputTokens: 200 } });
    run.streamMessage({ type: "summary", agent_id: session.id, run_id: run.id, status: "completed" });
    await settle();
    expect(session.contextUsage().value).toEqual({ tokens: null, contextWindow: null, percent: null });
    run.delta({ type: "model-call-completed", usage: { inputTokens: 50 } });
    run.end("finished"); await awaitTurnEnd(session, prompt.seq);
    expect(session.contextUsage().value?.tokens).toBe(50);
  } finally { await session.dispose(); }
});


test("the installed SDK does not expose per-call usage in nested task updates", () => {
  expect(NestedTaskUpdateSchema.safeParse({ type: "model-call-completed", modelCallId: "synthetic", usage: { inputTokens: 20, outputTokens: 2, cacheReadTokens: 10, cacheWriteTokens: 0 } }).success).toBe(false);
});
