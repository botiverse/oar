import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { awaitTurnEnd, promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { describe, start, tail } from "../fixtures/acp-session-support.js";

// oxlint-disable-next-line eslint/max-statements -- one specimen turn, asserted end to end.
test("ACP session records every update verbatim with its views, and the prompt answer as the turn end", async () => {
  const session = await start();
  const run = await promptAndWait(session, "tool");
  assert.equal(run.kind, "ended");
  assert.deepEqual(run.outcome, { kind: "completed" });
  assert.deepEqual(tail(session, run.result.request.seq - 1), [
    "request prompt",
    "response accepted",
    "event agent_thought_chunk → reasoning",
    "event tool_call → tool_call_started:Read",
    "event tool_call_update",
    "event tool_call_update → tool_call_ended",
    "event agent_message_chunk → text:tool-done",
    "event usage_update → usage",
    "event session/prompt → turn_ended:completed",
  ]);
  const toolEnded = session.records().find((record) => record.kind === "event" && record.body.views.some((view) => view.kind === "tool_call_ended"));
  assert.ok(toolEnded?.kind === "event");
  assert.deepEqual(toolEnded.body.views, [{
    kind: "tool_call_ended",
    callId: "call-read",
    output: JSON.stringify({ content: "fixture-value" }),
  }]);
  // native is the whole notification, untouched
  assert.deepEqual(toolEnded.body.native, {
    sessionId: "fake-session",
    update: { sessionUpdate: "tool_call_update", toolCallId: "call-read", status: "completed", rawOutput: { content: "fixture-value" } },
  });
  assert.deepEqual(session.contextUsage(), { tokens: 500, contextWindow: 2000, percent: 25 });
  await session.dispose();
  assert.deepEqual(session.records().slice(-2).map((record) => describe(record)), ["request dispose", "response exited"]);
});

test("the handshake answers are events, so model() is a fold over the stream", async () => {
  const session = await start();
  const opening = session.records().map((record) => describe(record));
  assert.deepEqual(opening.slice(0, 3), ["event initialize", "event authenticate", "event session/new → model:fixture-model-x"]);
  assert.equal(session.model(), "fixture-model-x");
  await session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- One lifecycle test must observe busy, abort, queue drain, and turn identity together.
test("ACP session rejects a second prompt busy and drains its host-held queue as a spontaneous turn", async () => {
  const session = await start();
  const first = await session.prompt("hold");
  assert.equal(first.response.body.kind, "accepted");
  const second = await session.prompt("must-be-busy");
  assert.deepEqual(second.response.body, { kind: "rejected", reason: "busy" });
  assert.deepEqual(session.capabilities.queue, { durable: false });
  const queued = await session.queue("queued");
  assert.equal(queued.response.body.kind, "accepted");
  const aborted = await session.abort();
  assert.equal(aborted.response.body.kind, "accepted");
  assert.deepEqual(await awaitTurnEnd(session, first.request.seq), { kind: "aborted" });
  // The queued input runs as its own turn: it has an end but no prompt request of its own.
  const ended = session.records().find((record) => record.kind === "event" && record.body.views.some((view) => view.kind === "turn_ended" && view.outcome.kind === "aborted"));
  assert.ok(ended !== undefined);
  const outcome = await awaitTurnEnd(session, ended.seq);
  assert.deepEqual(outcome, { kind: "completed" });
  const requests = session.records().filter((record) => record.kind === "request" && record.body.kind === "prompt");
  assert.equal(requests.length, 2, "only the two explicit prompts are prompt requests");
  assert.ok(session.records().some((record) => record.kind === "event" && record.body.views.some((view) => view.kind === "text_delta" && view.text === "echo:queued")));
  const late = await session.abort();
  assert.deepEqual(late.response.body, { kind: "rejected", reason: "no active turn" });
  await session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- both answers and the single end are one scenario.
test("ACP native steer (send-now) folds both prompt answers into one turn with one end", async () => {
  const session = await start({ steerParams: () => ({ _meta: { sendNow: true } }) });
  const base = await session.prompt("steer-base");
  const steered = await session.steer("steer-new");
  assert.equal(steered.response.body.kind, "accepted");
  assert.deepEqual(await awaitTurnEnd(session, base.request.seq), { kind: "completed" });
  const answers = session.records().filter((record) => record.kind === "event" && record.body.type === "session/prompt");
  assert.equal(answers.length, 2, "each prompt RPC answer is its own event");
  assert.deepEqual(answers.map((record) => (record.kind === "event" ? record.body.views.map((view) => view.kind) : [])), [[], ["turn_ended"]]);
  assert.ok(session.records().some((record) => record.kind === "event" && record.body.views.some((view) => view.kind === "text_delta" && view.text === "steer:steer-new")));
  await session.dispose();
});

test("steer is rejected not_steerable when the profile cannot inject or nothing is active", async () => {
  const session = await start();
  const idle = await session.steer("nothing active");
  const { body } = idle.response;
  assert.ok(body.kind === "rejected");
  assert.match(body.reason, /not_steerable/u);
  const later = await session.steerOrQueue("later");
  assert.equal(later.landed, "queued");
  await session.dispose();
});

test("ACP reverse permission requests are recorded toApp with oar's YOLO answer", async () => {
  const session = await start();
  const run = await promptAndWait(session, "permission");
  assert.equal(run.kind, "ended");
  assert.deepEqual(tail(session, run.result.request.seq - 1), [
    "request prompt",
    "response accepted",
    "toApp session/request_permission",
    "response answered",
    "event agent_message_chunk → text:permission:always",
    "event session/prompt → turn_ended:completed",
  ]);
  const answered = session.records().find((record) => record.kind === "response" && record.body.kind === "answered");
  assert.ok(answered?.kind === "response" && answered.body.kind === "answered");
  assert.deepEqual(answered.body.native, { outcome: { outcome: "selected", optionId: "always" } });
  const asked = session.records().find((record) => record.kind === "request" && record.direction === "toApp");
  assert.ok(asked?.kind === "request" && asked.id === answered.requestId, "the answer points at the runtime's request");
  await session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- two failure shapes side by side.
test("ACP prompt errors are the runtime's word; a process exit is oar's observation", async () => {
  const authSession = await start();
  const auth = await promptAndWait(authSession, "fail");
  assert.equal(auth.kind, "ended");
  expect(auth.outcome).toMatchInlineSnapshot(`
    {
      "failure": "auth",
      "kind": "failed",
      "reason": "Authentication required",
    }
  `);
  assert.ok(authSession.records().some((record) => record.kind === "event" && record.body.type === "session/prompt/error"));
  await authSession.dispose();

  const exitSession = await start();
  const exited = await promptAndWait(exitSession, "exit");
  assert.equal(exited.kind, "ended");
  expect(exited.outcome).toMatchInlineSnapshot(`
    {
      "failure": "runtime_exited",
      "kind": "failed",
      "reason": "runtime exited",
    }
  `);
  const exit = exitSession.records().findLast((record) => record.kind === "response" && record.body.kind === "exited");
  assert.ok(exit?.kind === "response" && exit.body.kind === "exited");
  assert.equal(exit.body.code, 9);
  assert.equal(exit.requestId, "", "an unrequested exit points at no request");
  const afterDeath = await exitSession.prompt("after death");
  assert.deepEqual(afterDeath.response.body, { kind: "rejected", reason: "runtime exited" }, "the kernel decides from the exited response, not an adapter flag");
  await exitSession.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- open, dispose, reopen, prompt, double-dispose.
test("ACP resume keeps the runtime-native session id and remains usable", async () => {
  const first = await start();
  const sessionId = first.id;
  await first.dispose();

  const resumed = await start({}, sessionId);
  assert.equal(resumed.id, sessionId);
  assert.equal(resumed.records().at(0)?.sessionId, sessionId);
  const run = await promptAndWait(resumed, "after-resume");
  assert.equal(run.kind, "ended");
  assert.deepEqual(run.outcome, { kind: "completed" });
  await resumed.dispose();
  await resumed.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- envelope, views, graph node and absent edge in one place.
test("a foreign session id is a derived child session: its own envelope id, a graph node, never dropped", async () => {
  const session = await start();
  const run = await promptAndWait(session, "spawn-child");
  assert.equal(run.kind, "ended");
  const child = session.records().find((record) => record.sessionId === "fake-child");
  assert.ok(child?.kind === "event");
  assert.deepEqual(child.body.views, [{ kind: "text_delta", text: "child-says-hi" }]);
  assert.deepEqual(child.agentPath, []);
  assert.deepEqual(session.graph().nodes.map((node) => node.id), ["fake-session", "fake-child"]);
  // Not subscribed to the vendor lifecycle method: no edge can be claimed.
  assert.deepEqual(session.graph().edges, []);
  await session.dispose();
});

test("a subscribed extension notification is recorded verbatim and links parent and child in the graph", async () => {
  const session = await start({ extensionNotifications: ["_x.ai/session_notification"] });
  const run = await promptAndWait(session, "spawn-child");
  assert.equal(run.kind, "ended");
  const lifecycle = session.records().find((record) => record.kind === "event" && record.body.type === "_x.ai/session_notification");
  assert.ok(lifecycle?.kind === "event");
  assert.deepEqual(lifecycle.body.native, { parentSessionId: "fake-session", sessionId: "fake-child", kind: "spawned" });
  assert.deepEqual(lifecycle.body.views, []);
  assert.deepEqual(session.graph().edges, [{ parent: "fake-session", child: "fake-child", via: "tool_call" }]);
  await session.dispose();
});

