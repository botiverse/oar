import { expect, test } from "vitest";
import { eventsOf } from "../packages/oar/src/observe/events.js";
import { awaitTurnEnd } from "../packages/oar/src/observe/turns.js";
import type { RawEvent, RuntimeEventBody, Session } from "../packages/oar/src/index.js";
import { startMockSession } from "../sea-trial/fixtures/mock-session.js";

function event(events: RuntimeEventBody[]): RawEvent {
  return { sessionId: "s", agentPath: [], seq: 4, receivedAt: 0, kind: "frame", body: { type: "fixture", native: null, events } };
}

test("eventsOf yields nothing for an accepted response or a frame oar read nothing from, and a turn_started for a prompt", () => {
  const prompt: RawEvent = { sessionId: "s", agentPath: [], seq: 0, receivedAt: 0, kind: "request", id: "rq", direction: "toRuntime", body: { kind: "prompt", input: "hi" } };
  const accepted: RawEvent = { sessionId: "s", agentPath: [], seq: 1, receivedAt: 0, kind: "response", requestId: "rq", body: { kind: "accepted" } };
  const rejected: RawEvent = { sessionId: "s", agentPath: [], seq: 2, receivedAt: 0, kind: "response", requestId: "rq", body: { kind: "rejected", reason: "busy" } };
  const exited: RawEvent = { sessionId: "s", agentPath: [], seq: 3, receivedAt: 0, kind: "response", requestId: "", body: { kind: "exited", code: 0 } };
  expect(eventsOf(prompt)).toMatchInlineSnapshot(`
    [
      {
        "agentPath": [],
        "input": "hi",
        "kind": "turn_started",
        "receivedAt": 0,
        "requestId": "rq",
        "seq": 0,
        "sessionId": "s",
      },
    ]
  `);
  expect(eventsOf(accepted)).toMatchInlineSnapshot(`[]`);
  expect(eventsOf(event([]))).toMatchInlineSnapshot(`[]`);
  expect(eventsOf(rejected)).toMatchInlineSnapshot(`[]`);
  expect(eventsOf(rejected, new Map([["rq", "steer"]]))).toMatchInlineSnapshot(`
    [
      {
        "action": "steer",
        "agentPath": [],
        "kind": "control_rejected",
        "reason": "busy",
        "receivedAt": 0,
        "requestId": "rq",
        "seq": 2,
        "sessionId": "s",
      },
    ]
  `);
  expect(eventsOf(exited)).toMatchInlineSnapshot(`
    [
      {
        "agentPath": [],
        "code": 0,
        "kind": "exited",
        "receivedAt": 0,
        "seq": 3,
        "sessionId": "s",
      },
    ]
  `);
});

const describe = (item: { seq: number; kind: string }): string => `${String(item.seq)} ${item.kind}`;

/** Subscribe from the start of the stream and collect `seq kind` lines. */
function tapFromStart(session: Session): string[] {
  const seen: string[] = [];
  session.events((item) => { seen.push(describe(item)); }, { cursor: { sessionId: session.id, afterSeq: -1 } });
  return seen;
}

// The mock stamps a `model` frame while opening, so the live tap replays from
// the start too; the point under test is that a late cursor subscription sees
// exactly what an early one saw, including everything after it.
async function replayFixture(): Promise<{ live: string[]; replayed: string[]; dispose: () => Promise<void> }> {
  const session = await startMockSession({ kind: "available", via: "bundled" }, { cwd: process.cwd() });
  const live = tapFromStart(session);
  const result = await session.prompt("hello");
  await awaitTurnEnd(session, result.request.seq);
  const replayed = tapFromStart(session);
  return { live, replayed, dispose: async () => session.dispose() };
}

test("events({ cursor }) replays the retained events, then continues live, identical to an early subscription", async () => {
  const { live, replayed, dispose } = await replayFixture();
  expect(replayed).toEqual(live);
  await dispose();
  expect(replayed).toEqual(live);
  expect(live.at(-1)?.endsWith(" exited")).toBe(true);
});
