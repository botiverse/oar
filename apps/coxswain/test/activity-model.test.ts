import { describe, expect, test } from "vitest";
import type { SessionEventBodyView, SessionEventView } from "../src/shared/ipc.js";
import { friendlyActivityRows } from "../src/renderer/views/cockpit/activity/activity-model.js";

function event<const Body extends SessionEventBodyView>(
  seq: number,
  body: Body,
  turnId = "turn-1",
): Body & {
  readonly sessionId: string;
  readonly turnId: string;
  readonly seq: number;
  readonly receivedAt: number;
} {
  return {
    sessionId: "session-1",
    turnId,
    seq,
    receivedAt: seq * 10,
    ...body,
  };
}

describe("friendlyActivityRows", () => {
  test("folds a tool lifecycle into one semantic row while grouping adjacent phases", () => {
    const events: readonly SessionEventView[] = [
      event(1, { kind: "turn_started" }),
      event(2, {
        kind: "tool_call_started",
        callId: "call-1",
        tool: "Bash",
        input: JSON.stringify({ command: "pnpm test" }),
      }),
      event(3, { kind: "reasoning", content: { kind: "text", text: "reading " } }),
      event(4, { kind: "reasoning", content: { kind: "text", text: "files" } }),
      event(5, { kind: "tool_call_ended", callId: "call-1", output: "ok" }),
      event(6, { kind: "text_delta", text: "hello " }),
      event(7, { kind: "text_delta", text: "world" }),
      event(8, { kind: "turn_ended", outcome: { kind: "completed" } }),
    ];

    expect(friendlyActivityRows("claude", events)).toMatchInlineSnapshot(`
      [
        {
          "kind": "turn",
          "receivedAt": 10,
          "seq": 1,
          "state": "started",
          "turnId": "turn-1",
        },
        {
          "actionKind": "run_command",
          "callId": "call-1",
          "detail": "pnpm test",
          "firstSeq": 2,
          "kind": "tool",
          "label": "Ran command",
          "lastAt": 50,
          "lastSeq": 5,
          "output": "ok",
          "startedAt": 20,
          "state": "done",
          "turnId": "turn-1",
        },
        {
          "firstSeq": 3,
          "kind": "phase",
          "lastAt": 40,
          "lastSeq": 4,
          "phase": "thinking",
          "startedAt": 30,
          "text": "reading files",
          "turnId": "turn-1",
        },
        {
          "firstSeq": 6,
          "kind": "phase",
          "lastAt": 70,
          "lastSeq": 7,
          "phase": "responding",
          "startedAt": 60,
          "text": "hello world",
          "turnId": "turn-1",
        },
        {
          "kind": "turn",
          "outcome": {
            "kind": "completed",
          },
          "receivedAt": 80,
          "seq": 8,
          "state": "completed",
          "turnId": "turn-1",
        },
      ]
    `);
  });

  test("passes the session runtime through OAR tool classification", () => {
    const events: readonly SessionEventView[] = [
      event(1, {
        kind: "tool_call_started",
        callId: "call-1",
        tool: "commandExecution",
        input: JSON.stringify({ command: ["bash", "-lc", "echo deep"] }),
      }),
    ];

    expect(friendlyActivityRows("codex-aimock", events)).toMatchInlineSnapshot(`
      [
        {
          "actionKind": "run_command",
          "callId": "call-1",
          "detail": "echo deep",
          "firstSeq": 1,
          "kind": "tool",
          "label": "Running command",
          "lastAt": 10,
          "lastSeq": 1,
          "startedAt": 10,
          "state": "running",
          "turnId": "turn-1",
        },
      ]
    `);
  });

  test("marks a still-open tool failed when its turn fails", () => {
    const events: readonly SessionEventView[] = [
      event(1, { kind: "tool_call_started", callId: "call-1", tool: "bash" }),
      event(2, {
        kind: "turn_ended",
        outcome: { kind: "failed", failure: "runtime_exited", reason: "process exited" },
      }),
    ];

    expect(friendlyActivityRows("pi", events)).toMatchObject([
      {
        actionKind: "run_command",
        callId: "call-1",
        label: "Command failed",
        lastAt: 20,
        lastSeq: 2,
        state: "failed",
      },
      {
        kind: "turn",
        state: "failed",
      },
    ]);
  });

  test("scopes reused call ids to their turn", () => {
    const events: readonly SessionEventView[] = [
      event(1, { kind: "tool_call_started", callId: "same", tool: "Read" }, "turn-1"),
      event(2, { kind: "tool_call_started", callId: "same", tool: "Write" }, "turn-2"),
      event(3, { kind: "tool_call_ended", callId: "same" }, "turn-1"),
    ];
    const rows = friendlyActivityRows("claude", events);

    expect(rows).toMatchObject([
      { actionKind: "read_file", state: "done", turnId: "turn-1" },
      { actionKind: "edit_file", state: "running", turnId: "turn-2" },
    ]);
  });
});
