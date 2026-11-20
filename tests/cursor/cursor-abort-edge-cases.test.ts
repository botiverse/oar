/* oxlint-disable eslint/max-statements -- Each test drives one multi-step abort lifecycle against a fake Cursor SDK. */
import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { cursorSessionWith } from "../../packages/oar/src/runtimes/cursor/session.js";
import { FakeCursorAgent } from "../fixtures/fake-cursor-sdk.js";

async function open(abortTimeoutMs = 50) {
  const agent = new FakeCursorAgent("agent-1", { id: "composer-2.5" });
  const session = await cursorSessionWith(async () => {
    await Promise.resolve();
    return {
      Agent: {
        create: async () => { await Promise.resolve(); return agent; },
        resume: async () => { await Promise.resolve(); return agent; },
        listRuns: async () => { await Promise.resolve(); return { items: [] }; },
      },
      Cursor: { models: { list: async () => { await Promise.resolve(); return []; } } },
    };
  }, { abortTimeoutMs })({ kind: "available", via: "bundled" }, { cwd: "/w" });
  return { session, agent };
}

test("Cursor abort classifies a cancel error after run end as no_active_turn and live refusal as runtime_refused", async () => {
  const { session, agent } = await open();
  try {
    await session.prompt("late-race");
    const first = agent.latest();
    first.cancel = async () => {
      first.end("finished");
      await Promise.resolve();
      throw new Error("run already finished");
    };
    const late = await session.abort();
    assert.equal(late.kind, "rejected");
    expect(late.response.body).toMatchObject({ kind: "rejected", code: "no_active_turn" });

    await session.prompt("live-refusal");
    const second = agent.latest();
    second.cancel = async () => {
      await Promise.resolve();
      throw new Error("native cancel refused");
    };
    const refused = await session.abort();
    assert.equal(refused.kind, "rejected");
    expect(refused.response.body).toMatchObject({ kind: "rejected", code: "runtime_refused", reason: "native cancel refused" });
    second.end("finished");
  } finally {
    await session.dispose();
  }
});

test("Cursor abort settles within abortTimeoutMs when run.cancel() hangs", async () => {
  const { session, agent } = await open(40);
  try {
    const started = await session.prompt("hang");
    const run = agent.latest();
    run.cancel = async () => Promise.withResolvers<void>().promise;
    const startedAt = Date.now();
    const aborted = await session.abort();
    expect(aborted.response.body).toEqual({ kind: "accepted" });
    expect(Date.now() - startedAt).toBeLessThan(2000);
    run.end("cancelled");
    expect(await awaitTurnEnd(session, started.seq)).toEqual({ kind: "aborted" });
  } finally {
    await session.dispose();
  }
});
