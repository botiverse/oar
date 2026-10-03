import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as settle } from "node:timers/promises";
import { expect, test } from "vitest";
import type { RequestRecord } from "../../packages/oar/src/contracts/session.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { codeOf, openFakeCursor, reasonOf } from "../fixtures/fake-cursor-sdk.js";

function imageFile(name: string, bytes: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-cursor-"));
  const file = path.join(dir, name);
  writeFileSync(file, bytes);
  return file;
}

test("a session is one SDK agent, opened without a sandbox, reporting the model the SDK holds", async () => {
  const { session, opened } = await openFakeCursor();
  assert.deepEqual(opened, [{ how: "create", options: { model: { id: "composer" }, local: { cwd: "/w", sandboxOptions: { enabled: false } } } }]);
  assert.equal(session.id, "agent-1");
  assert.equal(session.model().value, "composer");
  assert.deepEqual(session.capabilities, { steer: true, queue: { durable: false }, attribution: "attributed", images: true });
  await session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- one run, asserted end to end.
test("a prompt is one run: its updates are frames, its result ends the turn", async () => {
  const { session, agent } = await openFakeCursor();
  const prompt = await session.prompt("hello");
  assert.deepEqual(prompt.response.body, { kind: "accepted", native: { runId: "run-1" } });
  const run = agent.latest();
  assert.equal(run.message, "hello");
  run.delta({ type: "text-delta", text: "OAR" });
  run.delta({ type: "turn-ended", usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 0 } });
  run.end("finished", { result: "OAR" });
  assert.deepEqual(await awaitTurnEnd(session, prompt.seq), { kind: "completed" });
  const frames = session.records().flatMap((record) => (record.kind === "frame" ? [record.body.type] : []));
  assert.deepEqual(frames, ["cursor/agent_opened", "text-delta", "turn-ended", "cursor/run_result"]);
  assert.deepEqual(session.usage().value.total, { input: 15, output: 2 });
  assert.equal(session.model().value, "composer-2.5");
  assert.equal(session.status().value.kind, "idle");
  await session.dispose();
});

test("a second prompt while a run is in flight is busy", async () => {
  const { session, agent } = await openFakeCursor();
  await session.prompt("first");
  assert.equal(codeOf(await session.prompt("second")), "busy");
  assert.equal(agent.runs.length, 1);
  await session.dispose();
});

test("a steer is accepted once cursor took it, and its echo is a user message", async () => {
  const { session, agent } = await openFakeCursor();
  await session.prompt("work");
  const steer = await session.steer("also PELICAN");
  assert.deepEqual(steer.response.body, { kind: "accepted", native: { ack: "complete_delivered" } });
  assert.deepEqual(agent.latest().steered, ["also PELICAN"]);
  const echo = session.records().find((record) => record.kind === "frame" && record.body.type === "user-message-appended");
  assert.deepEqual(echo?.kind === "frame" ? echo.body.events : null, [{ kind: "user_message", input: "also PELICAN", evidence: "conversation" }]);
  await session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- the three ways a steer stays the caller's, in one run.
test("a steer cursor hands back, or never takes before the run ends, stays the caller's", async () => {
  const { session, agent } = await openFakeCursor();
  await session.prompt("work");
  agent.latest().ack = "revert_to_followup";
  const handedBack = await session.steer("too late");
  assert.equal(codeOf(handedBack), "runtime_refused");
  assert.equal(reasonOf(handedBack), "not_steerable: cursor handed the input back (revert_to_followup)");
  agent.latest().ack = "never";
  const pending = session.steer("never taken");
  await settle();
  agent.latest().end("finished");
  assert.equal(reasonOf(await pending), "not_steerable: the run ended before cursor took the input");
  assert.equal(codeOf(await session.steer("nothing running")), "no_active_turn");
  await session.dispose();
});

test("a steer with images is refused: cursor steers with text only", async () => {
  const { session } = await openFakeCursor();
  await session.prompt("work");
  const images = [{ path: imageFile("a.png", "png") }];
  assert.equal(codeOf(await session.steer("look", { images })), "unsupported");
  await session.dispose();
});

test("a prompt's images go as the SDK's image content", async () => {
  const { session, agent } = await openFakeCursor();
  await session.prompt("what color?", { images: [{ path: imageFile("red.png", "png-bytes") }] });
  assert.deepEqual(agent.latest().message, {
    text: "what color?",
    images: [{ data: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png" }],
  });
  await session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- both runs, in order.
test("queued input waits for the run to end, then is sent as a turn of its own", async () => {
  const { session, agent } = await openFakeCursor();
  const first = await session.prompt("first");
  const queued = await session.queue("later");
  assert.equal(queued.kind, "accepted");
  assert.equal(agent.runs.length, 1);
  agent.latest().end("finished");
  await awaitTurnEnd(session, first.seq);
  await settle();
  assert.deepEqual(agent.runs.map((run) => run.message), ["first", "later"]);
  agent.latest().end("finished");
  await settle();
  assert.equal(session.status().value.kind, "idle");
  await session.dispose();
});

test("abort cancels the run, and the run's own cancelled status ends the turn", async () => {
  const { session, agent } = await openFakeCursor();
  const prompt = await session.prompt("long");
  const abort = await session.abort();
  assert.equal(abort.kind, "accepted");
  assert.equal(agent.latest().cancelled, true);
  assert.deepEqual(await awaitTurnEnd(session, prompt.seq), { kind: "aborted" });
  assert.equal(codeOf(await session.abort()), "no_active_turn");
  await session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- the abort lands between send and its run.
test("an abort before the SDK returned the run cancels it as soon as it exists", async () => {
  const { session, agent } = await openFakeCursor();
  const release = Promise.withResolvers<void>();
  agent.gate = release.promise;
  const prompt = session.prompt("long");
  await settle();
  const abort = await session.abort();
  assert.equal(abort.kind, "accepted");
  release.resolve();
  const started = await prompt;
  assert.equal(agent.latest().cancelled, true);
  assert.deepEqual(await awaitTurnEnd(session, started.seq), { kind: "aborted" });
  await session.dispose();
});

test("dispose cancels the run, releases the agent and answers; control after it is refused", async () => {
  const { session, agent } = await openFakeCursor();
  await session.prompt("long");
  await session.dispose();
  assert.equal(agent.latest().cancelled, true);
  assert.equal(agent.closed, true);
  const dispose = session.records().find((record): record is RequestRecord => record.kind === "request" && record.body.kind === "dispose");
  assert.ok(session.records().some((record) => record.kind === "response" && record.requestId === dispose?.id && record.body.kind === "accepted"));
  assert.equal(codeOf(await session.prompt("after")), "disposed");
});

test("resume reopens the agent by id with the model its latest run ran", async () => {
  const { session, opened } = await openFakeCursor({ resume: "agent-9" });
  assert.equal(session.id, "agent-9");
  assert.deepEqual(opened, [{ how: "resume", id: "agent-9", options: { model: { id: "composer-2.5" }, local: { cwd: "/w", sandboxOptions: { enabled: false } } } }]);
  await session.dispose();
});

test("options the SDK cannot honor are refused at open", async () => {
  await expect(openFakeCursor({ systemPrompt: "x" })).rejects.toThrow("Cursor's SDK runs no system prompt override for a local agent");
  await expect(openFakeCursor({ appendSystemPrompt: "x" })).rejects.toThrow("Cursor's SDK runs no system prompt override for a local agent");
  await expect(openFakeCursor({ env: { A: "1" } })).rejects.toThrow("SessionOptions.env is unsupported");
  await expect(openFakeCursor({ env: {} })).resolves.toBeDefined();
});
