import { expect, test } from "vitest";
import { foldClaudeStdout, initialClaudeProjection } from "../../packages/oar/src/runtimes/claude/projection.js";

test.each([
  { native: {}, projected: {} },
  { native: { user_message_uuid: "last" }, projected: { inputId: "last" } },
  { native: { user_message_uuids: ["first", "last"] }, projected: { inputIds: ["first", "last"] } },
  { native: { user_message_uuid: "last", user_message_uuids: ["first", "last"] }, projected: { inputId: "last", inputIds: ["first", "last"] } },
  { native: { user_message_uuids: [] }, projected: { inputIds: [] } },
])("native turn-end identities are independent, ordered facts (%#)", ({ native, projected }) => {
  const message = { type: "result", subtype: "success", is_error: false, ...native };
  const folded = foldClaudeStdout(initialClaudeProjection, message);
  const frames = folded.commands.flatMap((command) => command.kind === "frame" ? [command.body] : []);
  expect(frames[0]?.native).toBe(message);
  expect(frames.flatMap((frame) => frame.events).filter((event) => event.kind === "turn_ended")).toEqual([{ kind: "turn_ended", outcome: { kind: "completed" }, ...projected }]);
});
