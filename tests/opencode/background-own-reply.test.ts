/* oxlint-disable eslint/max-lines-per-function, eslint/max-statements -- Each replay is one regression with its complete record assertions. */
import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { awaitIdle, promptAndWait, statusOf } from "../../packages/oar/src/observe/index.js";
import { viewOf } from "../../packages/oar/src/observe/session-view.js";
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

test("2.3.0 replay: the parent's own reply has no native start or end, so it stays activity and a later prompt is admitted", async () => {
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
    expect(session.status().value).toEqual({ kind: "idle", lastTurnOutcome: { kind: "completed" }, activity: { since: reply.receivedAt, lastEventAt: reply.receivedAt } });
    expect(viewOf(session.records()).messages.at(-1)).toMatchObject({ kind: "activity" });
    expect(await awaitIdle(session)).toBeNull();
    const abort = await session.abort();
    expect(abort.response.body).toMatchObject({ kind: "rejected", code: "no_active_turn" });
    const before = session.records().length;
    const followUp = await promptAndWait(session, "ACP_SHARE_A_followup");
    expect(followUp.kind).toBe("ended");
    const request = session.records().slice(before).find(record => record.kind === "request" && record.body.kind === "prompt");
    assert.ok(request?.kind === "request");
    expect(statusOf(session.records().filter(record => record.seq <= request.seq), "session-1").value.kind).toBe("running");
    expect(session.status().value).toEqual({ kind: "idle", lastTurnOutcome: { kind: "completed" } });
    expect(viewOf(session.records()).messages.filter(message => message.kind === "activity")).toHaveLength(1);
  } finally {
    await cleanup();
  }
});

test.each(["when_idle", "now"] as const)("2.3.0 replay: %s delivery during outside-turn activity prompts without a steer or queue", async when => {
  const { session, cleanup } = await replay(opencodeBackgroundChildProfile, "enabled-followup.json", withFollowUp());
  try {
    await ownReply(session);
    expect(session.status().value.kind).toBe("idle");
    const delivered = await session.deliver("ACP_SHARE_A_followup", when === "when_idle" ? { when } : {});
    expect(delivered.landed).toBe("prompted");
    expect(session.records().some(record => record.kind === "request" && (record.body.kind === "steer" || record.body.kind === "queue"))).toBe(false);
    expect(await awaitIdle(session)).toEqual({ kind: "completed" });
    expect(session.records().filter(record => record.kind === "request" && record.body.kind === "prompt")).toHaveLength(2);
  } finally {
    await cleanup();
  }
});
