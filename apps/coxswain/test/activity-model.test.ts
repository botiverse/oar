import { describe, expect, test } from "vitest";
import type { SessionEventBodyView, SessionEventView } from "../src/shared/ipc.js";
import { activityRows } from "../src/renderer/views/cockpit/activity/activity-model.js";

function event<const Body extends SessionEventBodyView>(
  seq: number,
  body: Body,
): Body & {
  readonly sessionId: string;
  readonly turnId: string;
  readonly seq: number;
  readonly receivedAt: number;
} {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    seq,
    receivedAt: seq * 10,
    ...body,
  };
}

describe("activityRows", () => {
  test("losslessly groups only adjacent deltas of the same kind and turn", () => {
    const events: readonly SessionEventView[] = [
      event(1, { kind: "turn_started" }),
      event(2, { kind: "reasoning", content: { kind: "text", text: "read" } }),
      event(3, { kind: "reasoning", content: { kind: "text", text: "ing" } }),
      event(4, { kind: "text_delta", text: "hello" }),
      event(5, { kind: "text_delta", text: " world" }),
      event(6, { kind: "tool_call_started", callId: "call-1", tool: "bash" }),
      event(7, { kind: "text_delta", text: "after tool" }),
    ];

    expect(activityRows(events)).toEqual([
      { kind: "event", event: events[0] },
      {
        kind: "delta",
        deltaKind: "reasoning",
        turnId: "turn-1",
        firstSeq: 2,
        lastSeq: 3,
        startedAt: 20,
        lastAt: 30,
        text: "reading",
      },
      {
        kind: "delta",
        deltaKind: "text",
        turnId: "turn-1",
        firstSeq: 4,
        lastSeq: 5,
        startedAt: 40,
        lastAt: 50,
        text: "hello world",
      },
      { kind: "event", event: events[5] },
      {
        kind: "delta",
        deltaKind: "text",
        turnId: "turn-1",
        firstSeq: 7,
        lastSeq: 7,
        startedAt: 70,
        lastAt: 70,
        text: "after tool",
      },
    ]);
  });

  test("preserves redacted and empty reasoning as explicit events", () => {
    const events: readonly SessionEventView[] = [
      event(1, { kind: "reasoning", content: { kind: "redacted" } }),
      event(2, { kind: "reasoning", content: { kind: "empty" } }),
    ];

    expect(activityRows(events)).toMatchInlineSnapshot(`
      [
        {
          "event": {
            "content": {
              "kind": "redacted",
            },
            "kind": "reasoning",
            "receivedAt": 10,
            "seq": 1,
            "sessionId": "session-1",
            "turnId": "turn-1",
          },
          "kind": "event",
        },
        {
          "event": {
            "content": {
              "kind": "empty",
            },
            "kind": "reasoning",
            "receivedAt": 20,
            "seq": 2,
            "sessionId": "session-1",
            "turnId": "turn-1",
          },
          "kind": "event",
        },
      ]
    `);
  });
});
