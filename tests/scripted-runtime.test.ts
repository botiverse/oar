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
