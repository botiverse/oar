import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as settle } from "node:timers/promises";
import { expect, onTestFinished, test } from "vitest";
import type { RequestRecord } from "../../packages/oar/src/contracts/session.js";
import { UnsupportedOptionError } from "../../packages/oar/src/index.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { codeOf, openFakeCursor, reasonOf } from "../fixtures/fake-cursor-sdk.js";

function imageFile(name: string, bytes: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-cursor-"));
  onTestFinished(() => { rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(path.join(dir, name), bytes);
  return path.join(dir, name);
}

test("a session is one SDK agent, opened without a sandbox, reporting the model the SDK holds", async () => {
  const { session, opened } = await openFakeCursor();
  assert.deepEqual(opened, [{ how: "create", options: { model: { id: "composer" }, local: { cwd: "/w", sandboxOptions: { enabled: false } } } }]);
  assert.equal(session.id, "agent-1");
  assert.equal(session.model().value, "composer");
  assert.deepEqual(session.capabilities, { queue: { durable: false }, attribution: "attributed", images: true });
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
  assert.deepEqual(session.usage().value.total, { input: 15, output: 2, cacheRead: 5, cacheWrite: 0 });
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

test.each(["what color?", ""])("a prompt's images go as the SDK's image content: %j", async (input) => {
  const { session, agent } = await openFakeCursor();
  await session.prompt(input, { images: [{ path: imageFile("red.png", "png-bytes") }] });
  assert.deepEqual(agent.latest().message, {
    text: input,
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

test("options the SDK cannot honor are refused at open, typed and named", async () => {
  const prompt = "Cursor's SDK runs no system prompt override for a local agent";
  await expect(openFakeCursor({ systemPrompt: "x" })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "systemPrompt", message: prompt });
  await expect(openFakeCursor({ appendSystemPrompt: "x" })).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "appendSystemPrompt", message: prompt });
  const env = openFakeCursor({ env: { A: "1" } });
  await expect(env).rejects.toBeInstanceOf(UnsupportedOptionError);
  await expect(env).rejects.toMatchObject({ option: "env" });
  await expect(env).rejects.toThrow("SessionOptions.env is unsupported");
  await expect(openFakeCursor({ env: {} })).resolves.toBeDefined();
});

// oxlint-disable-next-line eslint/max-statements -- a resumed session and a fresh one, side by side.
test("the first send after a resume takes the agent over from a run its store still holds", async () => {
  const { session, agent } = await openFakeCursor({ resume: "agent-9" });
  await session.prompt("first");
  agent.latest().end("finished");
  await settle();
  await session.prompt("second");
  assert.deepEqual(agent.forced, [true, false]);
  await session.dispose();
  const fresh = await openFakeCursor();
  await fresh.session.prompt("first");
  assert.deepEqual(fresh.agent.forced, [false]);
  await fresh.session.dispose();
});

test("a refused send is the prompt's refusal, and the session takes the next prompt", async () => {
  const { session, agent } = await openFakeCursor();
  agent.refuse = new Error("Agent agent-1 already has active run");
  const refused = await session.prompt("first");
  assert.equal(codeOf(refused), "runtime_refused");
  assert.equal(reasonOf(refused), "Agent agent-1 already has active run");
  assert.equal(session.status().value.kind, "idle");
  const again = await session.prompt("again");
  assert.equal(again.kind, "accepted");
  await session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- the held abort must not outlive its own launch.
test("an abort held for a send that is then refused does not cancel the next run", async () => {
  const { session, agent } = await openFakeCursor();
  const release = Promise.withResolvers<void>();
  agent.gate = release.promise;
  agent.refuse = new Error("network down");
  const prompt = session.prompt("first");
  await settle();
  const abort = await session.abort();
  assert.equal(abort.kind, "accepted");
  release.resolve();
  assert.equal(codeOf(await prompt), "runtime_refused");
  agent.gate = null;
  await session.prompt("second");
  assert.equal(agent.latest().cancelled, false);
  await session.dispose();
});

test("a run whose wait() throws ends the turn failed with the SDK's message", async () => {
  const { session, agent } = await openFakeCursor();
  const prompt = await session.prompt("work");
  agent.latest().fail(new Error("socket hang up"));
  assert.deepEqual(await awaitTurnEnd(session, prompt.seq), { kind: "failed", reason: "socket hang up", failure: "unknown" });
  assert.ok(session.records().some((record) => record.kind === "frame" && record.body.type === "cursor/run_failed"));
  await session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- one refused drain, then the next input still runs.
test("a queued input the SDK refuses is recorded, and the queue keeps draining", async () => {
  const { session, agent } = await openFakeCursor();
  await session.prompt("first");
  await session.queue("refused");
  await session.queue("next");
  agent.refuse = new Error("rate limited");
  agent.latest().end("finished");
  await settle();
  await settle();
  const rejected = session.records().find((record) => record.kind === "frame" && record.body.type === "cursor/send_rejected");
  assert.deepEqual(rejected?.kind === "frame" ? rejected.body.native : null, { message: "rate limited", input: "refused" });
  assert.deepEqual(agent.runs.map((run) => run.message), ["first", "next"]);
  await session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- two instant runs, then a held one.
test("runs that end the moment they start still leave the next input steerable and disposable", async () => {
  const { session, agent } = await openFakeCursor();
  agent.endAtOnce = "finished";
  await session.prompt("first");
  await session.queue("drained");
  await settle();
  agent.endAtOnce = null;
  await session.queue("held");
  await settle();
  const steer = await session.steer("into the held one");
  assert.equal(steer.kind, "accepted");
  await session.dispose();
  assert.equal(agent.latest().cancelled, true);
});

// oxlint-disable-next-line eslint/max-statements -- the late run is stopped and still recorded.
test("dispose while a send is pending answers at once, and a run that comes later is stopped", async () => {
  const { session, agent } = await openFakeCursor();
  const release = Promise.withResolvers<void>();
  agent.gate = release.promise;
  const prompt = session.prompt("long");
  await settle();
  await session.dispose();
  assert.equal(agent.closed, true);
  assert.equal(reasonOf(await prompt), "the session was disposed before cursor started the run");
  release.resolve();
  await settle();
  await settle();
  assert.equal(agent.latest().cancelled, true);
  assert.ok(session.records().some((record) => record.kind === "frame" && record.body.type === "cursor/run_result"));
});

// oxlint-disable-next-line eslint/max-statements -- the steer is issued while the send is held.
test("a steer during a pending send waits for the run, then steers it", async () => {
  const { session, agent } = await openFakeCursor();
  const release = Promise.withResolvers<void>();
  agent.gate = release.promise;
  const prompt = session.prompt("work");
  await settle();
  const steer = session.steer("also this");
  release.resolve();
  await prompt;
  const steered = await steer;
  assert.equal(steered.kind, "accepted");
  assert.deepEqual(agent.latest().steered, ["also this"]);
  await session.dispose();
});

test("a subagent's update keeps its agentPath through the session", async () => {
  const { session, agent } = await openFakeCursor();
  await session.prompt("delegate");
  agent.latest().delta({ type: "tool-call-delta", callId: "task-1", taskUpdate: { type: "text-delta", text: "child says" } });
  const child = session.records().find((record) => record.kind === "frame" && record.body.type === "tool-call-delta");
  assert.deepEqual(child?.agentPath, ["task-1"]);
  await session.dispose();
});
