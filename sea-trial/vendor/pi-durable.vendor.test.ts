import assert from "node:assert/strict";
import { afterEach, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc, type ConversationId } from "@earendil-works/pi-durable";
import { startDurableFixture, type DurableFixture } from "../harness/pi-durable.js";
import { awaitTurnEnd, promptAndWait } from "../../packages/oar/src/observe/turns.js";
import type { Session, SessionOptions } from "../../packages/oar/src/contracts/session.js";

const fixtures: DurableFixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) { await fixture.close(); } });
async function setup(): Promise<DurableFixture> {
  const fixture = await startDurableFixture();
  fixtures.push(fixture);
  return fixture;
}
async function open(fixture: DurableFixture, options: Partial<SessionOptions> = {}): Promise<Session> {
  return  fixture.runtime.session({ kind: "available", via: "bundled" }, { cwd: "/virtual", model: "aimock/aimock-model", ...options });
}
function id(value: number): value is ConversationId { return Number.isSafeInteger(value) && value > 0; }

const suite = describe.skipIf(process.env.OAR_TEST !== "pi-durable-aimock");
suite("Pi Durable native conversations against aimock", () => {
  test("prompt, busy rejection, queue, withdraw and native abort", async () => {
    const fixture = await setup();
    const session = await open(fixture);
    const result = await session.prompt("slow response");
    expect(result.kind).toBe("accepted");
    const busy = await session.prompt("busy");
    expect(busy.response.body.kind).toBe("rejected");
    const inputId = globalThis.crypto.randomUUID();
    const queued = await session.queue("never delivered", { inputId });
    expect(queued.kind).toBe("accepted");
    const withdrawn = await session.withdraw?.(inputId);
    expect(withdrawn?.kind).toBe("accepted");
    const aborted = await session.abort();
    expect(aborted.kind).toBe("accepted");
    expect(await awaitTurnEnd(session, result.seq)).toMatchInlineSnapshot(`
      {
        "kind": "aborted",
      }
    `);
    expect(session.status().value.kind).toBe("idle");
    await session.dispose();
  });

  test("a completed requestId is acknowledged without a second run", async () => {
    const fixture = await setup();
    const session = await open(fixture);
    const inputId = globalThis.crypto.randomUUID();
    const first = await session.prompt("first", { inputId });
    await awaitTurnEnd(session, first.seq);
    const repeated = await session.prompt("same logical input", { inputId });
    expect(repeated.kind).toBe("accepted");
    expect(await awaitTurnEnd(session, repeated.seq)).toMatchInlineSnapshot(`
      {
        "kind": "completed",
      }
    `);
    expect(session.status().value.kind).toBe("idle");
    expect(fixture.mock.getRequests()).toHaveLength(1);
    expect(session.records().filter((record) => record.kind === "frame").flatMap((record) => record.body.events).filter((event) => event.kind === "user_message")).toHaveLength(1);
    await session.dispose();
  });

  test("dispose detaches and a new observer adopts the active run before output", async () => {
    const fixture = await setup();
    const first = await open(fixture);
    await first.prompt("slow response");
    await first.dispose();
    const resumed = await open(fixture, { resume: first.id });
    expect(resumed.status().value.kind).toBe("running");
    const number = Number(first.id);
    assert.ok(id(number));
    const live = await fixture.harness.snapshot(LiveDoc, number, BACKGROUND_CONTEXT);
    expect(live?.run).toBeDefined();
    await resumed.abort();
    expect(resumed.status().value.kind).toBe("idle");
    await resumed.dispose();
  });

  test("retrying a completed input cannot end another active run", async () => {
    const fixture = await setup();
    const session = await open(fixture);
    const inputId = globalThis.crypto.randomUUID();
    const first = await session.prompt("first", { inputId });
    await awaitTurnEnd(session, first.seq);
    const active = await session.prompt("slow response");
    const retry = await session.prompt("retry", { inputId });
    expect(retry.kind).toBe("accepted");
    expect(session.status().value.kind).toBe("running");
    expect(await awaitTurnEnd(session, active.seq)).toEqual({ kind: "completed" });
    expect(fixture.mock.getRequests()).toHaveLength(2);
    await session.dispose();
  });

  test("adopting a run refuses changed settings atomically", async () => {
    const fixture = await setup();
    const first = await open(fixture, { appendSystemPrompt: "saved" });
    await first.prompt("slow response");
    await first.dispose();
    await expect(open(fixture, { resume: first.id, cwd: "/changed", appendSystemPrompt: "changed" })).rejects.toThrow("cannot change options");
    const resumed = await open(fixture, { resume: first.id, appendSystemPrompt: "saved" });
    expect(resumed.status().value.kind).toBe("running");
    await resumed.abort();
    await resumed.dispose();
  });

  test("instructions persist on reopen and a supplied append replaces the saved value", async () => {
    const fixture = await setup();
    const first = await open(fixture, { appendSystemPrompt: "first instructions" });
    const number = Number(first.id);
    assert.ok(id(number));
    await first.dispose();
    const restored = await open(fixture, { resume: first.id });
    
    const native = await fixture.harness.conversation(number, BACKGROUND_CONTEXT);
    const saved = await native?.agent(BACKGROUND_CONTEXT);
    expect(saved?.instructions).toBe("first instructions");
    await restored.dispose();
    const changed = await open(fixture, { resume: first.id, appendSystemPrompt: "replacement" });
    const updated = await native?.agent(BACKGROUND_CONTEXT);
    expect(updated?.instructions).toBe("replacement");
    const run = await promptAndWait(changed, "hello");
    expect(run.kind).toBe("ended");
    await changed.dispose();
  });
});
