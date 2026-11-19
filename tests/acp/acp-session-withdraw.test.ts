import { expect, test } from "vitest";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { conversationOf } from "../../packages/oar/src/observe/conversation.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { start } from "../fixtures/acp-session-support.js";
import { fixture as sharedFixture, text as sharedText } from "../fixtures/acp-shared-support.js";
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

// oxlint-disable-next-line eslint/max-statements -- Verify synchronous queue admission before microtask settlement on isolated ACP.
test("withdraw called synchronously with queue takes back the input before queue's promise settles", async () => {
  const session = await start();
  try {
    const first = await session.prompt("hold");
    const withdrawnId = "22222222-2222-4222-8222-222222222222";
    const queuedPromise = session.queue("withdrawn", { inputId: withdrawnId });
    const withdrawnPromise = withdraw(session, withdrawnId);
    const kept = await session.queue("kept");
    const [queued, withdrawnResult] = await Promise.all([queuedPromise, withdrawnPromise]);
    expect([queued.kind, withdrawnResult, kept.kind]).toEqual(["accepted", "accepted", "accepted"]);
    await session.abort();
    expect(await awaitTurnEnd(session, first.seq)).toEqual({ kind: "aborted" });
    expect(await awaitTurnEnd(session, lastSeq(session))).toEqual({ kind: "completed" });
    expect(said(session)).toEqual(["echo:kept"]);
    expect([...conversationOf(session.records()).inputs.values()].find(item => item.inputId === withdrawnId)?.state).toBe("withdrawn");
  } finally { await session.dispose(); }
});

test("reentrant ACP queues preserve recorded request order and respect dispatch-observer disposal", async () => {
  const session = await start();
  try {
    const second: { value?: ReturnType<typeof session.queue> } = {};
    session.rawEvents(record => {
      if (record.kind === "request" && record.body.kind === "queue" && record.body.input === "first") {
        second.value = session.queue("second");
      }
    });
    const first = await session.queue("first");
    await second.value;
    expect(await awaitTurnEnd(session, first.seq)).toEqual({ kind: "completed" });
    expect(await awaitTurnEnd(session, lastSeq(session))).toEqual({ kind: "completed" });
    expect(said(session)).toEqual(["echo:first", "echo:second"]);
  } finally { await session.dispose(); }
});

// oxlint-disable-next-line eslint/max-statements -- Exercise shared ACP synchronous withdraw, acceptance observer withdraw, and disposal gate.
test("shared ACP sessions admit and withdraw held input synchronously without overtaking acceptance observers or disposal", async () => {
  const f = await sharedFixture();
  const [a, b] = await Promise.all([f.open("a"), f.open("b")]);
  try {
    const obsId = "33333333-3333-4333-8333-333333333333";
    const obsWithdraw: { value?: Promise<string> } = {};
    const off = a.rawEvents(record => {
      if (record.kind === "response" && record.body.kind === "accepted" && record.body.queued === "adapter") {
        obsWithdraw.value = withdraw(a, obsId);
      }
    });
    await a.queue("never-sent", { inputId: obsId });
    off();
    expect(await obsWithdraw.value).toBe("accepted");
    const holdTurn = await a.prompt("hold");
    const syncId = "44444444-4444-4444-8444-444444444444";
    const [syncQueued, syncWithdrawn] = await Promise.all([a.queue("also-withdrawn", { inputId: syncId }), withdraw(a, syncId)]);
    expect([syncQueued.kind, syncWithdrawn]).toEqual(["accepted", "accepted"]);
    const remaining = await a.queue("held-until-dispose");
    const disposing = a.dispose();
    expect(await withdraw(a, inputIdOf(remaining))).toBe("disposed");
    await disposing;
    expect(sharedText(a)).not.toContain("never-sent");
    expect(sharedText(a)).not.toContain("also-withdrawn");
    expect(sharedText(a)).not.toContain("held-until-dispose");
    expect(holdTurn.kind).toBe("accepted");
  } finally {
    await a.dispose();
    await b.dispose();
  }
});
