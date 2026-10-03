import { setImmediate as settle } from "node:timers/promises";
import { expect, test } from "vitest";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { openFakeCursor } from "../fixtures/fake-cursor-sdk.js";
import { inputIdOf, withdraw } from "../fixtures/withdraw.js";

// The cursor agent takes one run at a time, so queued input is held by the
// adapter and sent when the run ends: until then it can be taken back.
// oxlint-disable-next-line eslint/max-statements -- one held queue, withdrawn, drained and asked again, in order.
test("a cursor input withdrawn before the run ends is never sent; the next held input still is", async () => {
  const { session, agent } = await openFakeCursor();
  const first = await session.prompt("first");
  const withdrawn = await session.queue("withdrawn");
  const kept = await session.queue("kept");
  expect(await withdraw(session, inputIdOf(withdrawn))).toBe("accepted");
  agent.latest().end("finished");
  await awaitTurnEnd(session, first.seq);
  await settle();
  expect(agent.runs.map((run) => run.message)).toEqual(["first", "kept"]);
  expect(await withdraw(session, inputIdOf(kept))).toBe("not_queued");
  expect(await withdraw(session, inputIdOf(withdrawn))).toBe("not_queued");
  expect(await withdraw(session, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")).toBe("not_queued");
  agent.latest().end("finished");
  await settle();
  expect(session.status().value.kind).toBe("idle");
  await session.dispose();
});

test("a queue while idle is sent at once; after dispose a withdraw is refused disposed", async () => {
  const { session, agent } = await openFakeCursor();
  const idle = await session.queue("idle");
  expect(await withdraw(session, inputIdOf(idle))).toBe("not_queued");
  expect(agent.runs.map((run) => run.message)).toEqual(["idle"]);
  const held = await session.queue("held");
  await session.dispose();
  expect(await withdraw(session, inputIdOf(held))).toBe("disposed");
  expect(agent.runs.map((run) => run.message)).toEqual(["idle"]);
});
