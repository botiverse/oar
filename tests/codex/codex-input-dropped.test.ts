import { expect, test } from "vitest";
import { acceptCodexSteer } from "../../packages/oar/src/runtimes/codex/input-delivery.js";
import { foldCodexNotification, initialCodexProjection, type CodexProjectionState } from "../../packages/oar/src/runtimes/codex/projection.js";

function accepted(state: CodexProjectionState, inputId: string, turnId = "turn-1"): CodexProjectionState {
  return { ...state, inputs: acceptCodexSteer(state.inputs, turnId, inputId) };
}
function echo(state: CodexProjectionState, inputId: string): CodexProjectionState {
  return foldCodexNotification(state, "item/started", { threadId: "root", turnId: "turn-1", item: { type: "userMessage", id: `item-${inputId}`, clientId: inputId, content: [{ type: "text", text: inputId }] } }).state;
}
function end(state: CodexProjectionState, status = "interrupted", threadId = "root") {
  return foldCodexNotification(state, "turn/completed", { threadId, turn: { id: "turn-1", status } });
}

test("an interrupted root turn drops only its accepted un-echoed steers, before its end", () => {
  let state = initialCodexProjection("root");
  state = accepted(accepted(accepted(state, "read"), "unread"), "other-turn", "turn-2");
  state = echo(state, "read");
  const result = end(state);
  expect(result.commands).toMatchInlineSnapshot(`
    [
      {
        "body": {
          "events": [
            {
              "inputId": "unread",
              "kind": "input_dropped",
              "reason": "turn_interrupted",
            },
            {
              "kind": "turn_ended",
              "outcome": {
                "kind": "aborted",
              },
            },
          ],
          "native": {
            "threadId": "root",
            "turn": {
              "id": "turn-1",
              "status": "interrupted",
            },
          },
          "type": "turn/completed",
        },
        "kind": "frame",
        "spanId": "turn-1",
      },
    ]
  `);
  expect([...result.state.inputs.keys()]).toEqual(["turn-2"]);
  expect(end(result.state).commands.flatMap((command) => command.kind === "frame" ? command.body.events : []).some((event) => event.kind === "input_dropped")).toBe(false);
});

test.each(["completed", "failed"])("a %s turn makes no discard claim", (status) => {
  const state = accepted(initialCodexProjection("root"), "input");
  const result = end(state, status);
  expect(result.commands.flatMap((command) => command.kind === "frame" ? command.body.events : []).some((event) => event.kind === "input_dropped")).toBe(false);
  expect(result.state.inputs.size).toBe(0);
});

test("an echo before the steer reply prevents a false drop", () => {
  const state = accepted(echo(initialCodexProjection("root"), "early-echo"), "early-echo");
  expect(end(state).commands.flatMap((command) => command.kind === "frame" ? command.body.events : []).map((event) => event.kind)).toEqual(["turn_ended"]);
});

test("a child completion cannot discard root steering even with the same turn id", () => {
  const state = accepted(initialCodexProjection("root"), "root-input");
  const child = end(state, "interrupted", "child");
  expect(child.state.inputs).toEqual(state.inputs);
  expect(child.commands.flatMap((command) => command.kind === "frame" ? command.body.events : []).some((event) => event.kind === "input_dropped")).toBe(false);
  expect(end(child.state).commands.flatMap((command) => command.kind === "frame" ? command.body.events : []).filter((event) => event.kind === "input_dropped")).toEqual([{ kind: "input_dropped", inputId: "root-input", reason: "turn_interrupted" }]);
});
