import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "vitest";
import type { Event, Session } from "../packages/oar/src/index.js";
import { awaitTurnEnd } from "../packages/oar/src/observe/turns.js";
import { scriptedRuntime, type ScriptedTurn } from "../packages/oar/src/testing/index.js";

/**
 * The public test runtime: a script's words become ordinary events, its
 * outcome the runtime's own turn end. The session contract itself is proven
 * by the behavior suite (`OAR_TEST=scripted pnpm sea-trial`).
 */

const open = async (turn: (turn: ScriptedTurn) => void | Promise<void>): Promise<Session> =>
  scriptedRuntime({ turn }).session({ kind: "available", via: "bundled" }, { cwd: process.cwd() });

/** Every event of the session, collected from now on. */
const collect = (session: Session): Event[] => {
  const events: Event[] = [];
  session.events((event) => {
    events.push(event);
  });
  return events;
};

const waitFor = async (done: () => boolean): Promise<void> => {
  if (!done()) {
    await delay(5);
    await waitFor(done);
  }
};

test("a script's text, reasoning and tool call become events, ended by the runtime's turn end", async () => {
  const session = await open(async ({ input, say, think, tool }) => {
    think("planning");
    await tool("read", "notes.md", () => "contents");
    say(`done: ${input}`);
  });
  const events = collect(session);
  const started = await session.prompt("fix it");
  const outcome = await awaitTurnEnd(session, started.seq);
  assert.deepEqual(outcome, { kind: "completed" });
  assert.deepEqual(events.map((event) => event.kind), ["turn_started", "reasoning", "tool_call_started", "tool_call_ended", "text_delta", "turn_ended", "usage"]);
  const ended = events.find((event) => event.kind === "tool_call_ended");
  assert.ok(ended?.kind === "tool_call_ended" && ended.result === "ok" && ended.output === "contents");
  assert.equal(session.model().value, "scripted-1");
  await session.dispose();
});

test("a throwing script ends its turn failed and the session stays usable", async () => {
  let calls = 0;
  const session = await open(() => {
    calls += 1;
    if (calls === 1) {
      throw new Error("boom");
    }
  });
  const first = await session.prompt("one");
  assert.deepEqual(await awaitTurnEnd(session, first.seq), { kind: "failed", reason: "boom", failure: "unknown" });
  const second = await session.prompt("two");
  assert.deepEqual(await awaitTurnEnd(session, second.seq), { kind: "completed" });
  await session.dispose();
});

test("steers reach the running turn; a second prompt is busy", async () => {
  const gate = Promise.withResolvers<undefined>();
  const seen: string[][] = [];
  const session = await open(async ({ steered }) => {
    await gate.promise;
    seen.push([...steered]);
  });
  const first = await session.prompt("long");
  const [busy, steer] = [await session.prompt("again"), await session.steer("also this")];
  gate.resolve(undefined);
  await awaitTurnEnd(session, first.seq);
  await session.dispose();
  assert.ok(busy.kind === "rejected" && busy.code === "busy");
  assert.deepEqual([steer.kind, seen], ["accepted", [["also this"]]]);
});

test("an abort ends the turn aborted; a late abort and a prompt after dispose are rejected", async () => {
  const session = await open(async ({ signal }) => {
    await once(signal, "abort");
  });
  const started = await session.prompt("abort me");
  const abort = await session.abort();
  assert.equal(abort.kind, "accepted");
  assert.deepEqual(await awaitTurnEnd(session, started.seq), { kind: "aborted" });
  const late = await session.abort();
  await session.dispose();
  const after = await session.prompt("after");
  assert.ok(late.kind === "rejected" && late.code === "no_active_turn");
  assert.ok(after.kind === "rejected" && after.code === "runtime_exited");
});

test("a queued input runs as its own turn after the active one", async () => {
  const inputs: string[] = [];
  const session = await open(async ({ input }) => {
    inputs.push(input);
    await delay(5);
  });
  const first = await session.prompt("first");
  const queued = await session.queue("second");
  await awaitTurnEnd(session, first.seq);
  await waitFor(() => inputs.length === 2);
  assert.equal(queued.kind, "accepted");
  assert.deepEqual(inputs, ["first", "second"]);
  await session.dispose();
});

test("the accepted response comes before the turn's first event", async () => {
  const session = await open(({ say }) => {
    say("hello");
  });
  const started = await session.prompt("hi");
  await awaitTurnEnd(session, started.seq);
  const kinds = session.records().map((record) => (record.kind === "frame" ? record.body.type : record.kind));
  assert.deepEqual(kinds.slice(0, 4), ["scripted/model", "request", "response", "scripted/text"]);
  await session.dispose();
});

const openAsking = async (turn: (turn: ScriptedTurn) => void | Promise<void>): Promise<Session> =>
  scriptedRuntime({ turn }).session({ kind: "available", via: "bundled" }, { cwd: process.cwd(), approvals: "ask" });

const toAppIds = (session: Session): string[] =>
  session.records().flatMap((record) => (record.kind === "request" && record.direction === "toApp" ? [record.id] : []));

// oxlint-disable-next-line eslint/max-statements -- the ask, its answer, and the grant a second turn uses are one scenario.
test("approve asks the host in an ask session, waits for its answer, and remembers a grant for the session", async () => {
  const answers: unknown[] = [];
  const session = await openAsking(async ({ approve, say }) => {
    answers.push(await approve("shell", "rm -rf build"));
    say("next");
  });
  const first = await session.prompt("one");
  await waitFor(() => toAppIds(session).length === 1);
  assert.deepEqual(session.status().value.awaiting, toAppIds(session));
  const [requestId] = toAppIds(session);
  const granted = await session.answer(requestId ?? "", { kind: "allow", scope: "session" });
  assert.equal(granted.kind, "accepted");
  await awaitTurnEnd(session, first.seq);
  const second = await session.prompt("two");
  await awaitTurnEnd(session, second.seq);
  assert.deepEqual(answers, [{ kind: "allow", scope: "session" }, { kind: "allow", scope: "session" }]);
  assert.equal(toAppIds(session).length, 1, "the grant let the second call through unasked");
  await session.dispose();
});

// oxlint-disable-next-line eslint/max-statements -- the gated and the ungated session side by side.
test("an aborted turn withdraws what it asks; without approvals \"ask\" approve allows at once and ask refuses", async () => {
  const answers: unknown[] = [];
  const session = await openAsking(async ({ ask }) => {
    answers.push(await ask([{ question: "Which color?", options: [{ label: "Red" }] }]));
  });
  const started = await session.prompt("go");
  await waitFor(() => toAppIds(session).length === 1);
  const aborted = await session.abort();
  assert.equal(aborted.kind, "accepted");
  await awaitTurnEnd(session, started.seq);
  await waitFor(() => answers.length === 1);
  assert.deepEqual(answers, [{ kind: "withdrawn" }]);
  const late = await session.answer(toAppIds(session)[0] ?? "", { kind: "answer", answers: { "Which color?": "Red" } });
  assert.ok(late.kind === "rejected" && late.code === "withdrawn");
  await session.dispose();

  const yolo: unknown[] = [];
  const plain = await open(async ({ approve, ask }) => {
    yolo.push(await approve("shell", "ls"));
    await ask([{ question: "q", options: [] }]);
  });
  const run = await plain.prompt("go");
  const outcome = await awaitTurnEnd(plain, run.seq);
  assert.deepEqual(yolo, [{ kind: "allow" }]);
  assert.ok(outcome.kind === "failed" && outcome.reason.includes('questions need a session opened with approvals "ask"'));
  assert.deepEqual(toAppIds(plain), []);
  await plain.dispose();
});
