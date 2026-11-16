import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import type { ControlOutcome, Event, RawEvent, Session } from "../packages/oar/src/index.js";
import { awaitTurnEnd } from "../packages/oar/src/observe/turns.js";
import { scriptedRuntime, type ScriptedTurn } from "../packages/oar/src/testing/index.js";

/**
 * The runtime's process dying on its own (`turn.exit`), recorded as the
 * process adapters record an exit nobody requested: a standalone `exited`
 * response (requestId "", no reason) and no synthesized `turn_ended`, so a
 * host can test its crash path on a real Session.
 */

const open = async (turn: (turn: ScriptedTurn) => void | Promise<void>): Promise<Session> =>
  scriptedRuntime({ turn }).session({ kind: "available", via: "bundled" }, { cwd: process.cwd() });

const collect = (session: Session): Event[] => {
  const events: Event[] = [];
  session.events((event) => {
    events.push(event);
  });
  return events;
};

/** The exited responses, as [requestId, body]. */
const exits = (records: readonly RawEvent[]): unknown[] =>
  records.flatMap((record) => (record.kind === "response" && record.body.kind === "exited" ? [[record.requestId, record.body]] : []));

/** A record in brief: what it is and, for a response, whether it answers a request. */
function describe(record: RawEvent): string {
  if (record.kind === "response") {
    return `response to ${record.requestId === "" ? "nothing" : "a request"}: ${JSON.stringify(record.body)}`;
  }
  return record.kind === "request" ? `request ${record.body.kind}` : `frame ${record.body.type}`;
}

/** A turn that says something, exits mid-turn, then keeps talking: what it saw and the turn's prompt. */
async function crashMidTurn(): Promise<{ readonly session: Session; readonly events: Event[]; readonly observed: RawEvent[]; readonly seen: { inputs: string[]; aborted: boolean }; readonly queued: ControlOutcome; readonly prompted: ControlOutcome }> {
  const seen: { inputs: string[]; aborted: boolean } = { inputs: [], aborted: false };
  const session = await open(({ input, say, signal, exit }) => {
    seen.inputs.push(input);
    say("partial");
    exit();
    seen.aborted = signal.aborted;
    say("after the exit");
  });
  const events = collect(session);
  const observed: RawEvent[] = [];
  session.rawEvents((record) => {
    observed.push(record);
  });
  const prompted = await session.prompt("crash");
  const queued = await session.queue("never runs");
  return { session, events, observed, seen, queued, prompted };
}

/** A session whose script kept its turn's `exit`, its one turn completed. */
async function openKeepingExit(): Promise<{ readonly session: Session; readonly exit: ScriptedTurn["exit"] }> {
  const kept: { exit?: ScriptedTurn["exit"] } = {};
  const session = await open((turn) => {
    kept.exit = turn.exit;
    turn.say("done");
  });
  const started = await session.prompt("one");
  assert.deepEqual(await awaitTurnEnd(session, started.seq), { kind: "completed" });
  assert.ok(kept.exit !== undefined, "the turn ran");
  return { session, exit: kept.exit };
}

test("an exit mid-turn ends the turn failed runtime_exited, with no turn_ended", async () => {
  const { session, events, prompted } = await crashMidTurn();
  expect(await awaitTurnEnd(session, prompted.seq)).toMatchInlineSnapshot(`
    {
      "failure": "runtime_exited",
      "kind": "failed",
      "reason": "runtime exited",
    }
  `);
  await delay(0);
  expect([events.map((event) => event.kind), session.status().value]).toMatchInlineSnapshot(`
    [
      [
        "turn_started",
        "text_delta",
        "exited",
      ],
      {
        "kind": "idle",
        "lastTurnOutcome": {
          "failure": "runtime_exited",
          "kind": "failed",
          "reason": "runtime exited",
        },
      },
    ]
  `);
  await session.dispose();
});

test("an exit mid-turn aborts the script's signal, drops the held queue and reaches observers", async () => {
  const { session, observed, seen, queued, prompted } = await crashMidTurn();
  await awaitTurnEnd(session, prompted.seq);
  await delay(0);
  assert.deepEqual([queued.kind, seen], ["accepted", { inputs: ["crash"], aborted: true }]);
  assert.deepEqual(exits(observed), exits(session.records()), "observers see the exit");
  expect(exits(session.records())).toMatchInlineSnapshot(`
    [
      [
        "",
        {
          "code": 1,
          "kind": "exited",
        },
      ],
    ]
  `);
  await session.dispose();
});

test("an exit while idle keeps the last turn's outcome", async () => {
  const { session, exit } = await openKeepingExit();
  const events = collect(session);
  exit(null);
  expect([events.map((event) => event.kind), session.status().value, exits(session.records())]).toMatchInlineSnapshot(`
    [
      [
        "exited",
      ],
      {
        "kind": "idle",
        "lastTurnOutcome": {
          "kind": "completed",
        },
      },
      [
        [
          "",
          {
            "code": null,
            "kind": "exited",
          },
        ],
      ],
    ]
  `);
  await session.dispose();
});

test("every control after an exit is rejected runtime_exited", async () => {
  const { session, exit } = await openKeepingExit();
  exit();
  const after = [
    await session.prompt("two"),
    await (session.steer?.("steer") ?? assert.fail("the scripted runtime steers")),
    await session.queue("three"),
    await (session.withdraw?.("held") ?? assert.fail("the scripted runtime withdraws")),
    await session.abort(),
  ];
  expect(after.map((result) => `${result.request.body.kind}: ${result.kind === "rejected" ? result.code : result.kind}`)).toMatchInlineSnapshot(`
    [
      "prompt: runtime_exited",
      "steer: runtime_exited",
      "queue: runtime_exited",
      "withdraw: runtime_exited",
      "abort: runtime_exited",
    ]
  `);
  await session.dispose();
});

test("dispose after an exit is recorded and answered accepted at once; a second exit records nothing", async () => {
  const { session, exit } = await openKeepingExit();
  const before = session.records().length;
  exit(137);
  exit(1);
  await session.dispose();
  await session.dispose();
  exit(2);
  expect(session.records().slice(before).map((record) => describe(record))).toMatchInlineSnapshot(`
    [
      "response to nothing: {"kind":"exited","code":137}",
      "request dispose",
      "response to a request: {"kind":"accepted"}",
    ]
  `);
});

test("a task the script started reports nothing after the exit", async () => {
  const kept: { task?: ReturnType<ScriptedTurn["task"]>; exit?: ScriptedTurn["exit"] } = {};
  const session = await open((turn) => {
    kept.task = turn.task({ taskType: "shell", background: true });
    kept.exit = turn.exit;
  });
  const started = await session.prompt("start a job");
  await awaitTurnEnd(session, started.seq);
  kept.exit?.();
  const before = session.records().length;
  kept.task?.end("completed");
  assert.equal(session.records().length, before, "no task_ended after the process exited");
  await session.dispose();
});
