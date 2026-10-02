import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import type { Session } from "../packages/oar/src/contracts/session.js";
import { conversationOf } from "../packages/oar/src/observe/conversation.js";
import { awaitIdle } from "../packages/oar/src/observe/turns.js";
import { scriptedRuntime } from "../packages/oar/src/testing/index.js";
import { Gate } from "./fixtures/subagent-fixtures.js";

async function sessionOf(gate: Gate): Promise<Session> {
  const session = await scriptedRuntime({ turn: gate.script }).session({ kind: "available", via: "bundled" }, { cwd: process.cwd() });
  return session;
}

const origin = { kind: "notification", source: "ci" } as const;

async function settledWithin(pending: Promise<unknown>, ms: number): Promise<boolean> {
  const settled = (async (): Promise<boolean> => {
    await pending;
    return true;
  })();
  const result = await Promise.race([settled, delay(ms, false)]);
  return result;
}

test("deliver wakes an idle session with a turn, and the origin reaches the conversation projection", async () => {
  const gate = new Gate();
  const session = await sessionOf(gate);
  const result = await session.deliver("build finished", { origin });
  expect(result).toMatchObject({ landed: "prompted" });
  gate.release();
  await awaitIdle(session);
  const inputs = [...conversationOf(session.records()).inputs.values()];
  expect(inputs).toMatchObject([{ input: "build finished", inputId: result.inputId, origin, state: "accepted" }]);
  await session.dispose();
});

test("deliver now steers a running turn", async () => {
  const gate = new Gate();
  const session = await sessionOf(gate);
  await session.prompt("work");
  expect(await session.deliver("also check the tests")).toMatchObject({ landed: "steered" });
  gate.release();
  await awaitIdle(session);
  await session.dispose();
});

test("deliver after_turn queues behind a running turn", async () => {
  const gate = new Gate();
  const session = await sessionOf(gate);
  await session.prompt("work");
  expect(await session.deliver("next thing", { when: "after_turn" })).toMatchObject({ landed: "queued" });
  gate.release();
  gate.release();
  await expect.poll(() => gate.started, { timeout: 5000 }).toBe(2);
  await session.dispose();
});

test("deliver when_idle waits for the running turn to end, then starts one", async () => {
  const gate = new Gate();
  const session = await sessionOf(gate);
  await session.prompt("work");
  await expect.poll(() => gate.started, { timeout: 5000 }).toBe(1);
  const pending = session.deliver("when you are free", { when: "when_idle" });
  expect(await settledWithin(pending, 100)).toBe(false);
  gate.release();
  expect(await pending).toMatchObject({ landed: "prompted" });
  gate.release();
  await session.dispose();
});
