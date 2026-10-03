import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import type { ControlOutcome, Session } from "../packages/oar/src/index.js";
import { awaitTurnEnd, conversationOf } from "../packages/oar/src/observe/index.js";
import { scriptedRuntime } from "../packages/oar/src/testing/index.js";
import { startMockSession } from "../sea-trial/fixtures/mock-session.js";
import { inputIdOf, withdraw } from "./fixtures/withdraw.js";

interface Held {
  readonly session: Session;
  /** The input of every turn the script ran, in order. */
  readonly ran: readonly string[];
  /** End the running turn and wait until the session is past it. */
  readonly finish: (prompt: ControlOutcome) => Promise<void>;
}

/** Let a scripted turn start (it begins on the next macrotask) or settle. */
const settle = async (): Promise<void> => {
  await delay(5);
};

/** A scripted session whose turns run until the test finishes them. */
async function held(): Promise<Held> {
  const ran: string[] = [];
  const releases: (() => void)[] = [];
  const session = await scriptedRuntime({
    turn: async ({ input, say }) => {
      ran.push(input);
      const { promise, resolve } = Promise.withResolvers<void>();
      releases.push(resolve);
      await promise;
      say(`echo:${input}`);
    },
  }).session({ kind: "available", via: "bundled" }, { cwd: process.cwd() });
  const finish = async (prompt: ControlOutcome): Promise<void> => {
    await settle();
    releases.shift()?.();
    await awaitTurnEnd(session, prompt.seq);
    await settle();
  };
  return { session, ran, finish };
}

test("an input withdrawn before its turn is never run; the queue request and its response stay as recorded", async () => {
  const { session, ran, finish } = await held();
  const first = await session.prompt("first");
  const queued = await session.queue("later");
  expect(await withdraw(session, inputIdOf(queued))).toBe("accepted");
  await finish(first);
  expect(ran).toEqual(["first"]);
  expect(session.status().value.kind).toBe("idle");
  expect(session.records().find((record) => record.seq === queued.seq)).toBe(queued.request);
  expect([...conversationOf(session.records()).inputs.values()].map((input) => [input.input, input.state])).toEqual([["first", "accepted"], ["later", "withdrawn"]]);
  await session.dispose();
});

test("an input the queue already ran, and an id never queued, are not_queued", async () => {
  const { session, ran, finish } = await held();
  const first = await session.prompt("first");
  const queued = await session.queue("next");
  await finish(first);
  expect(ran).toEqual(["first", "next"]);
  expect(await withdraw(session, inputIdOf(queued))).toBe("not_queued");
  expect(await withdraw(session, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")).toBe("not_queued");
  await session.dispose();
});

test("a queue while idle starts its turn at once, so there is nothing to withdraw", async () => {
  const { session, ran } = await held();
  const queued = await session.queue("now");
  expect(await withdraw(session, inputIdOf(queued))).toBe("not_queued");
  await settle();
  expect(ran).toEqual(["now"]);
  await session.dispose();
});

test("after dispose a withdraw is refused by the reachability rule, before the queue is consulted", async () => {
  const { session } = await held();
  await session.prompt("first");
  const queued = await session.queue("later");
  await session.dispose();
  // The scripted dispose is answered with an exit, which the kernel reads first.
  expect(await withdraw(session, inputIdOf(queued))).toBe("runtime_exited");
});

test("the sea-trial mock holds its queue the same way", async () => {
  const session = await startMockSession({ kind: "available", via: "bundled" }, { cwd: process.cwd() });
  const first = await session.prompt("hang");
  const queued = await session.queue("later");
  expect(await withdraw(session, inputIdOf(queued))).toBe("accepted");
  expect(await withdraw(session, inputIdOf(queued))).toBe("not_queued");
  await session.abort();
  await awaitTurnEnd(session, first.seq);
  expect(session.status().value.kind).toBe("idle");
  await session.dispose();
  expect(await withdraw(session, inputIdOf(queued))).toBe("runtime_exited");
});
