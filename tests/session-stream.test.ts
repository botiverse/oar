import assert from "node:assert/strict";
import { test } from "vitest";
import { awaitTurnEnd, promptAndWait } from "../packages/oar/src/observe/turns.js";
import type { RequestRecord, ResponseRecord, SessionRecord } from "../packages/oar/src/index.js";
import { startMockSession } from "../sea-trial/fixtures/mock-session.js";

const installation = { kind: "available", via: "bundled" } as const;

function describe(record: SessionRecord): string {
  if (record.kind === "event") {
    return record.body.views.length === 0 ? `event ${record.body.type}` : record.body.views.map((view) => view.kind).join("+");
  }
  return `${record.kind} ${record.body.kind}`;
}

function assertDenseRootOrder(records: readonly SessionRecord[], sessionId: string): void {
  for (const [index, record] of records.entries()) {
    assert.equal(record.seq, index, "seq is dense and starts at 0");
    assert.equal(record.sessionId, sessionId);
    assert.deepEqual(record.agentPath, []);
  }
}

function acceptedPrompt(records: readonly SessionRecord[]): { prompt: RequestRecord; accepted: ResponseRecord } {
  const prompt = records.find((record): record is RequestRecord => record.kind === "request" && record.body.kind === "prompt");
  assert.ok(prompt !== undefined);
  const accepted = records.find((record): record is ResponseRecord => record.kind === "response" && record.requestId === prompt.id);
  assert.ok(accepted !== undefined);
  return { prompt, accepted };
}

test("the stream is one total order: requests, responses and events share seq", async () => {
  const session = await startMockSession(installation, { cwd: process.cwd() });
  const run = await promptAndWait(session, "hello");
  assert.equal(run.kind, "ended");
  await session.dispose();
  assertDenseRootOrder(session.records(), session.id);
  const { prompt, accepted } = acceptedPrompt(session.records());
  assert.equal(accepted.seq, prompt.seq + 1, "the response follows its request");
  assert.equal(run.outcome.kind, "completed");
});

function subscribeAfter(session: Awaited<ReturnType<typeof startMockSession>>, afterSeq: number): number[] {
  const seen: number[] = [];
  session.subscribe((record) => {
    seen.push(record.seq);
  }, { sessionId: session.id, afterSeq });
  return seen;
}

function assertContiguousAfter(seen: readonly number[], afterSeq: number, replayedCount: number): void {
  assert.ok(replayedCount > 0 && seen[0] === afterSeq + 1, "replay starts right after the cursor");
  assert.ok(seen.length > replayedCount, "live records keep arriving");
  assert.deepEqual(seen, seen.map((_, index) => afterSeq + 1 + index), "no loss, no duplication across the replay/live boundary");
}

test("subscribe with a cursor replays retained records after afterSeq, then continues live", async () => {
  const session = await startMockSession(installation, { cwd: process.cwd() });
  const first = await promptAndWait(session, "one");
  assert.equal(first.kind, "ended");
  const afterSeq = first.result.request.seq;
  const seen = subscribeAfter(session, afterSeq);
  const replayedCount = seen.length;
  await promptAndWait(session, "two");
  assertContiguousAfter(seen, afterSeq, replayedCount);
  assert.throws(() => session.subscribe(() => {}, { sessionId: "other", afterSeq: 0 }), /cursor belongs to session other/u);
  await session.dispose();
});

test("prompt while a turn is active is rejected busy; abort when idle is rejected", async () => {
  const session = await startMockSession(installation, { cwd: process.cwd() });
  const first = await session.prompt("one");
  assert.equal(first.response.body.kind, "accepted");
  const second = await session.prompt("two");
  assert.deepEqual(second.response.body, { kind: "rejected", reason: "busy" });
  const outcome = await awaitTurnEnd(session, first.request.seq);
  assert.deepEqual(outcome, { kind: "completed" });
  const late = await session.abort();
  assert.equal(late.response.body.kind, "rejected");
  await session.dispose();
});

test("abort ends the active turn with the runtime's aborted report", async () => {
  const session = await startMockSession(installation, { cwd: process.cwd() });
  const started = await session.prompt("hang");
  const aborted = await session.abort();
  assert.equal(aborted.response.body.kind, "accepted");
  assert.deepEqual(await awaitTurnEnd(session, started.request.seq), { kind: "aborted" });
  await session.dispose();
});

test("dispose records the request and the observed exit; a second dispose is a no-op", async () => {
  const session = await startMockSession(installation, { cwd: process.cwd() });
  await session.dispose();
  await session.dispose();
  const tail = session.records().slice(-2).map((record) => describe(record));
  assert.deepEqual(tail, ["request dispose", "response exited"]);
});

test("model, usage and contextUsage are folds over the stream", async () => {
  const session = await startMockSession(installation, { cwd: process.cwd() });
  assert.equal(session.model(), "mock-1");
  assert.equal(session.contextUsage(), null);
  assert.deepEqual(session.usage(), { total: { input: 0, output: 0 } });
  await promptAndWait(session, "hello");
  assert.deepEqual(session.contextUsage(), { tokens: 1, contextWindow: 100, percent: 1 });
  assert.deepEqual(session.usage(), { total: { input: 1, output: 1 } });
  await session.dispose();
});

