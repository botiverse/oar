import { describe, expect, test } from "vitest";
import type { SessionEventBodyView, SessionEventView } from "../src/shared/ipc.js";
import {
  contractLensForEvents,
  invariantLabel,
  reduceContractLensEvents,
  initialContractLensState,
} from "../src/renderer/views/contract-lens/contract-lens-model.js";
import { smokeRegattaFixture } from "../src/renderer/views/regatta/regatta-fixture.js";

function event(
  seq: number,
  receivedAt: number,
  body: SessionEventBodyView,
  turnId = "turn-1",
  sessionId = "session-1",
): SessionEventView {
  return { sessionId, turnId, seq, receivedAt, ...body };
}

describe("contract lens", () => {
  test("accepts an ordinary monotonic turn", () => {
    const state = contractLensForEvents([
      event(0, 100, { kind: "turn_started" }),
      event(1, 100, { kind: "reasoning", content: { kind: "redacted" } }),
      event(2, 101, { kind: "turn_ended", outcome: { kind: "completed" } }),
    ], "alpha");

    expect(state).toMatchInlineSnapshot(`
      {
        "alarms": [],
        "turns": [
          {
            "ended": true,
            "lastReceivedAt": 101,
            "sessionId": "session-1",
            "turnId": "turn-1",
          },
        ],
      }
    `);
  });

  test("reports duplicate ends, post-terminal events, and backwards timestamps", () => {
    const state = contractLensForEvents([
      event(0, 100, { kind: "turn_started" }),
      event(1, 90, { kind: "reasoning", content: { kind: "empty" } }),
      event(2, 110, { kind: "turn_ended", outcome: { kind: "completed" } }),
      event(3, 105, { kind: "text_delta", text: "late" }),
      event(4, 120, { kind: "turn_ended", outcome: { kind: "completed" } }),
    ], "alpha");

    expect(state.alarms).toMatchInlineSnapshot(`
      [
        {
          "eventKind": "reasoning",
          "invariant": "received_at_monotonic",
          "laneId": "alpha",
          "message": "receivedAt 90 is earlier than 100",
          "previousReceivedAt": 100,
          "receivedAt": 90,
          "seq": 1,
          "sessionId": "session-1",
          "turnId": "turn-1",
        },
        {
          "eventKind": "text_delta",
          "invariant": "no_events_after_turn_end",
          "laneId": "alpha",
          "message": "event text_delta arrived after turn turn-1 ended",
          "receivedAt": 105,
          "seq": 3,
          "sessionId": "session-1",
          "turnId": "turn-1",
        },
        {
          "eventKind": "text_delta",
          "invariant": "received_at_monotonic",
          "laneId": "alpha",
          "message": "receivedAt 105 is earlier than 110",
          "previousReceivedAt": 110,
          "receivedAt": 105,
          "seq": 3,
          "sessionId": "session-1",
          "turnId": "turn-1",
        },
        {
          "eventKind": "turn_ended",
          "invariant": "turn_end_once",
          "laneId": "alpha",
          "message": "turn turn-1 ended more than once",
          "receivedAt": 120,
          "seq": 4,
          "sessionId": "session-1",
          "turnId": "turn-1",
        },
        {
          "eventKind": "turn_ended",
          "invariant": "no_events_after_turn_end",
          "laneId": "alpha",
          "message": "event turn_ended arrived after turn turn-1 ended",
          "receivedAt": 120,
          "seq": 4,
          "sessionId": "session-1",
          "turnId": "turn-1",
        },
      ]
    `);
  });

  test("keeps turns with the same id separate across sessions", () => {
    const state = reduceContractLensEvents(initialContractLensState, [
      event(0, 100, { kind: "turn_ended", outcome: { kind: "completed" } }, "same", "one"),
      event(0, 50, { kind: "turn_started" }, "same", "two"),
      event(1, 50, { kind: "turn_ended", outcome: { kind: "completed" } }, "same", "two"),
    ]);

    expect(state.alarms).toEqual([]);
    expect(state.turns).toHaveLength(2);
  });

  test("scopes timestamp ordering to one session and turn", () => {
    const state = contractLensForEvents([
      event(0, 200, { kind: "turn_started" }, "first"),
      event(1, 100, { kind: "turn_started" }, "second"),
      event(2, 50, { kind: "turn_started" }, "first", "session-2"),
    ]);

    expect(state.alarms).toEqual([]);
  });

  test("keeps an alarm in the deterministic screenshot fixture", () => {
    const codex = smokeRegattaFixture().state.find((lane) => lane.identity.laneId === "codex");
    if (codex === undefined) {
      throw new Error("missing Codex smoke lane");
    }

    expect(contractLensForEvents(codex.activity, codex.identity.laneId).alarms)
      .toMatchObject([{ invariant: "no_events_after_turn_end", laneId: "codex", seq: 3 }]);
  });

  test("names all first-slice invariants", () => {
    expect([
      invariantLabel("turn_end_once"),
      invariantLabel("no_events_after_turn_end"),
      invariantLabel("received_at_monotonic"),
    ]).toEqual([
      "turn ended more than once",
      "event after turn ended",
      "receivedAt moved backwards",
    ]);
  });
});
