import { expect, test } from "vitest";
import { foldClaudeStdout, initialClaudeProjection } from "../../packages/oar/src/runtimes/claude/projection.js";

test("Claude projects tool_progress heartbeats to tool_call_progress with elapsedSeconds", () => {
  const folded = foldClaudeStdout(initialClaudeProjection, {
    type: "tool_progress",
    tool_use_id: "toolu_abc-heartbeat-3",
    elapsed_time_seconds: 12.5,
  });
  const events = folded.commands.flatMap((command) => command.kind === "frame" ? command.body.events : []);
  expect(events).toEqual([{ kind: "tool_call_progress", callId: "toolu_abc", elapsedSeconds: 12.5 }]);

  const ignored = foldClaudeStdout(initialClaudeProjection, {
    type: "tool_progress",
    tool_use_id: "",
    elapsed_time_seconds: 5,
  });
  expect(ignored.commands.flatMap((command) => command.kind === "frame" ? command.body.events : [])).toEqual([]);
});
