import { expect, test } from "vitest";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { start } from "../fixtures/acp-session-support.js";
import { inputIdOf, withdraw } from "../fixtures/withdraw.js";

function lastSeq(session: Session): number {
  return session.records().at(-1)?.seq ?? -1;
}

/** Every text the agent said, in order. */
function said(session: Session): string[] {
  return session.records().flatMap((record) => (record.kind === "frame"
    ? record.body.events.flatMap((view) => (view.kind === "text_delta" ? [view.text] : []))
    : []));
}

// The ACP queue is OAR's (turns.ts), not the vendor's: kimi, grok and
// antigravity sessions all take queued input back the same way.
// oxlint-disable-next-line eslint/max-statements -- one held queue, withdrawn, drained and asked again, in order.
test("an ACP input withdrawn before the turn ends is never prompted; the next held input still drains", async () => {
  const session = await start();
  const first = await session.prompt("hold");
  const withdrawn = await session.queue("withdrawn");
  const kept = await session.queue("kept");
  expect([withdrawn.kind, kept.kind]).toEqual(["accepted", "accepted"]);
  expect(await withdraw(session, inputIdOf(withdrawn))).toBe("accepted");
  await session.abort();
  expect(await awaitTurnEnd(session, first.seq)).toEqual({ kind: "aborted" });
  // The drained input runs as a turn of its own, ending after the aborted one.
  expect(await awaitTurnEnd(session, lastSeq(session))).toEqual({ kind: "completed" });
  expect(said(session)).toEqual(["echo:kept"]);
  expect(await withdraw(session, inputIdOf(kept))).toBe("not_queued");
  expect(await withdraw(session, inputIdOf(withdrawn))).toBe("not_queued");
  expect(await withdraw(session, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")).toBe("not_queued");
  await session.dispose();
});

test("a queue while idle starts its turn at once, so there is nothing to withdraw", async () => {
  const session = await start();
  const idle = await session.queue("idle");
  expect(await withdraw(session, inputIdOf(idle))).toBe("not_queued");
  expect(await awaitTurnEnd(session, idle.seq)).toEqual({ kind: "completed" });
  expect(said(session)).toEqual(["echo:idle"]);
  await session.dispose();
});

test("a withdraw while dispose is under way is refused disposed, and the held input is never prompted", async () => {
  const session = await start();
  await session.prompt("hold");
  const held = await session.queue("held");
  const disposing = session.dispose();
  expect(await withdraw(session, inputIdOf(held))).toBe("disposed");
  await disposing;
  expect(said(session)).toEqual([]);
});
