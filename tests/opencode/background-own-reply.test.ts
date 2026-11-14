/* oxlint-disable eslint/max-lines-per-function, eslint/max-statements -- Each replay is one regression with its complete record assertions. */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { awaitIdle, promptAndWait, statusOf } from "../../packages/oar/src/observe/index.js";
import { opencodeBackgroundChildProfile } from "../../packages/oar/src/runtimes/opencode/session.js";
import { eventsOf, frames, notificationsOf, replay, wireOf, type ReplayedRun, type WireFrame } from "../fixtures/opencode-background-replay.js";

/**
 * OpenCode 2.3.0: after the background child completes, the parent model
 * answers OpenCode's report on its own. ACP carries that reply as root updates
 * after the prompt answered, with no native start or end (docs/runtimes/opencode.md).
 */

/**
 * The enabled recording, then one follow-up prompt. The follow-up's answer is
 * synthetic: the recorded prompt answer, renumbered. The native follow-up
 * itself was checked on 2.3.0 in the PR #775 review control (ended, then idle).
 */
function withFollowUp(): WireFrame[] {
  const wire = wireOf("enabled.json");
  const prompt = wire.find(({ direction, message }) => direction === "toRuntime" && message.method === "session/prompt");
  const answer = wire.find(({ direction, message }) => direction === undefined && prompt !== undefined && message.id === prompt.message.id && "result" in message);
  const last = wire.at(-1);
  assert.ok(prompt !== undefined && answer !== undefined && last !== undefined);
  return [...wire,
    { atMs: last.atMs + 1, direction: "toRuntime", message: { ...prompt.message, id: 3 } },
    { atMs: last.atMs + 2, message: { ...answer.message, id: 3 } }];
}

type Replayed = ReplayedRun["session"];

/** The parent's own reply: the only root frame after the child completed, and the last native frame of the 60 second recording. */
async function ownReply(session: Replayed) {
  const first = await promptAndWait(session, "ACP_SHARE_A_child");
  expect(first.kind).toBe("ended");
  await expect.poll(() => eventsOf(session.records(), "session-1").filter((event) => event.kind === "text_delta").length).toBe(2);
  const reply = frames(session.records(), "session-1").at(-1);
  assert.ok(reply !== undefined);
  return reply;
}

test("2.3.0 replay: the parent's own reply has no native start or end, so status stays running and a later prompt is still admitted", async () => {
  const { session, cleanup } = await replay(opencodeBackgroundChildProfile, "enabled-followup.json", withFollowUp());
  try {
    const reply = await ownReply(session);
    // One root text chunk under a new message id after the prompt answered; nothing follows it
    // (no usage_update, session_info_update, extension or other marker) in the 60 seconds recorded.
    expect(notificationsOf("enabled.json").at(-1)).toEqual({ method: "session/update", params: reply.body.native });
    expect(reply.body.native).toMatchInlineSnapshot(`
      {
        "sessionId": "session-1",
        "update": {
          "content": {
            "text": "ANSWER_A_child",
            "type": "text",
          },
          "messageId": "message-5",
          "sessionUpdate": "agent_message_chunk",
        },
      }
    `);
    expect(reply.body.events).toEqual([{ kind: "text_delta", text: "ANSWER_A_child" }]);
    // The fold adopts it as a running turn with no request or input identity; nothing native ends it.
    expect(session.status().value).toEqual({ kind: "running", phase: "responding", sinceSeq: reply.seq, lastEventAt: reply.receivedAt });
    // The wait and a when_idle delivery stay pending through the reply: drain scheduled work, then look.
    const settled: { afterSeq?: number } = {};
    const idle = (async () => {
      const outcome = await awaitIdle(session);
      settled.afterSeq = session.records().at(-1)?.seq ?? -1;
      return outcome;
    })();
    const whenIdle = session.deliver("ACP_SHARE_A_when_idle", { when: "when_idle" });
    await delay(50);
    expect(settled.afterSeq).toBeUndefined();
    expect(session.records().filter((record) => record.kind === "request" && record.body.kind === "prompt")).toHaveLength(1);
    // OAR's turn driver has no open turn (no OpenCode profile maps runtime turns), so a prompt is
    // admitted although status says running: the documented exception to status and admission agreeing.
    const before = session.records().length;
    const followUp = await promptAndWait(session, "ACP_SHARE_A_followup");
    expect(followUp.kind).toBe("ended");
    const request = session.records().slice(before).find((record) => record.kind === "request");
    assert.ok(request?.kind === "request" && request.body.kind === "prompt");
    expect(statusOf(session.records().filter((record) => record.seq <= request.seq), "session-1").value.kind).toBe("running");
    const admitted = session.records().find((record) => record.kind === "response" && record.requestId === request.id);
    expect(admitted?.kind === "response" ? admitted.body.kind : null).toBe("accepted");
    // Only the follow-up's own native answer returns the root to idle and settles the idle wait.
    const end = frames(session.records(), "session-1").find((record) => record.seq > request.seq && record.body.events.some((event) => event.kind === "turn_ended"));
    assert.ok(end !== undefined);
    expect(statusOf(session.records().filter((record) => record.seq < end.seq), "session-1").value.kind).toBe("running");
    expect(await idle).toEqual({ kind: "completed" });
    expect(settled.afterSeq ?? -1).toBeGreaterThanOrEqual(end.seq);
    // The when_idle delivery is dispatched only once the follow-up's native end made the root idle.
    await expect.poll(() => session.records().filter((record) => record.kind === "request" && record.body.kind === "prompt").length).toBe(3);
    const dispatched = session.records().findLast((record) => record.kind === "request" && record.body.kind === "prompt");
    assert.ok(dispatched !== undefined);
    expect(dispatched.seq).toBeGreaterThan(end.seq);
    void whenIdle;
  } finally {
    await cleanup();
  }
});

test("2.3.0 replay: deliver during the parent's own reply sends no steer and queues, and the adapter queue sends it at once because no OAR turn is open", async () => {
  const { session, cleanup } = await replay(opencodeBackgroundChildProfile, "enabled-followup.json", withFollowUp());
  try {
    await ownReply(session);
    expect(session.status().value.kind).toBe("running");
    // The recorded initialize advertises `_session/steering`, so the session has `steer`. With no
    // OAR turn open, deliver's steer is refused `no_active_turn` before any native request.
    expect(typeof session.steer).toBe("function");
    const delivered = await session.deliver("ACP_SHARE_A_followup");
    expect(delivered.landed).toBe("queued");
    const steer = session.records().find((record) => record.kind === "request" && record.body.kind === "steer");
    assert.ok(steer?.kind === "request");
    expect(session.records().find((record) => record.kind === "response" && record.requestId === steer.id)?.body).toMatchObject({ kind: "rejected", code: "no_active_turn" });
    expect(session.records().some((record) => record.kind === "frame" && record.body.type.startsWith("_session/steering"))).toBe(false);
    expect(await awaitIdle(session)).toEqual({ kind: "completed" });
    const prompts = session.records().flatMap((record) => record.kind === "request" && record.body.kind === "prompt" ? [record.body.carries] : []);
    expect(prompts).toEqual([undefined, [delivered.inputId]]);
  } finally {
    await cleanup();
  }
});
