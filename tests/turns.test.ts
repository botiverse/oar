import assert from "node:assert/strict";
import { test } from "vitest";
import type { Session } from "../packages/oar/src/index.js";
import { awaitIdle, awaitTurnEnd, promptAndWait } from "../packages/oar/src/observe/turns.js";
import { startMockSession } from "../sea-trial/fixtures/mock-session.js";

/**
 * The control answers a consumer holds (`ControlOutcome`), the status fold
 * behind `busy`, and the turn helpers built on both, on the mock session.
 */

const open = async (): Promise<Session> => startMockSession({ kind: "available", via: "bundled" }, { cwd: process.cwd() });

test("control answers are the records, read: accepted carries the request seq, a rejection its code", async () => {
  const session = await open();
  const first = await session.prompt("one");
  const second = await session.prompt("two");
  assert.equal(first.kind, "accepted");
  assert.equal(first.seq, first.request.seq, "seq is the request's position in the stream");
  assert.ok(second.kind === "rejected" && second.code === "busy", "a second prompt is busy, by code");
  assert.equal(second.response.body.kind, "rejected", "the records stay underneath");
  await awaitTurnEnd(session, first.seq);
  await session.dispose();
});

test("a late abort and a control after the exit are rejected with a code, not prose alone", async () => {
  const session = await open();
  const late = await session.abort();
  assert.ok(late.kind === "rejected" && late.code === "no_active_turn", "a late abort is a race, with a code");
  await session.dispose();
  const after = await session.prompt("after");
  assert.ok(after.kind === "rejected" && after.code === "runtime_exited", "the kernel's reachability gate answers with a code too");
});

test("status() folds the stream: idle, running since the prompt request, idle at the turn end", async () => {
  const session = await open();
  assert.equal(session.status().value.kind, "idle");
  const first = await session.prompt("one");
  const running = session.status().value;
  assert.ok(running.kind === "running" && running.sinceSeq === first.seq, "running since the prompt request");
  await awaitTurnEnd(session, first.seq);
  assert.equal(session.status().value.kind, "idle");
  await session.dispose();
});

test("busy agrees with status(): rejected exactly while running, never while idle", async () => {
  const session = await open();
  const first = await session.prompt("one");
  const during = await session.prompt("two");
  await awaitTurnEnd(session, first.seq);
  const after = await session.prompt("three");
  assert.ok(during.kind === "rejected" && during.code === "busy");
  assert.equal(after.kind, "accepted");
  await awaitTurnEnd(session, after.seq);
  await session.dispose();
});

test("awaitIdle resolves at once when idle and with the running turn's outcome otherwise", async () => {
  const session = await open();
  assert.equal(await awaitIdle(session), null, "already idle: nothing to wait for");
  await session.prompt("one");
  assert.deepEqual(await awaitIdle(session), { kind: "completed" }, "resolves with the running turn's outcome");
  assert.equal(session.status().value.kind, "idle");
  await session.dispose();
});

test("promptAndWait ends with the runtime's outcome and the turn's text; a rejected prompt returns without waiting", async () => {
  const session = await open();
  const ended = await promptAndWait(session, "hello");
  assert.ok(ended.kind === "ended" && ended.outcome.kind === "completed");
  assert.equal(ended.text, "echo:hello");
  const holding = await session.prompt("one");
  const refused = await promptAndWait(session, "two");
  assert.ok(refused.kind === "rejected" && refused.code === "busy");
  await awaitTurnEnd(session, holding.seq);
  await session.dispose();
});

test("promptAndWait aborts at the caller's limit and reports the runtime's own turn end", async () => {
  const session = await open();
  const timedOut = await promptAndWait(session, "hang", { timeoutMs: 20 });
  assert.ok(timedOut.kind === "interrupted" && timedOut.by === "timeout");
  assert.deepEqual(timedOut.outcome, { kind: "aborted" }, "the outcome is the runtime's turn end, not a guess");
  const controller = new AbortController();
  setTimeout(() => { controller.abort(); }, 5);
  const cancelled = await promptAndWait(session, "hang", { signal: controller.signal });
  assert.ok(cancelled.kind === "interrupted" && cancelled.by === "signal");
  await session.dispose();
});
