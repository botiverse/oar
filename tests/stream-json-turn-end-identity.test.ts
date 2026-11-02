import { expect, test } from "vitest";
import { foldClaudeStdout, initialClaudeProjection } from "../packages/oar/src/runtimes/claude/projection.js";

import { qwenProjectionProfile, initialQwenProjection } from "../packages/oar/src/runtimes/qwen/projection.js";
import { qoderProjectionProfile, initialQoderProjection } from "../packages/oar/src/runtimes/qoder/projection.js";
import { foldStreamJsonStdout } from "../packages/oar/src/shared/stream-json/projection.js";

const runtimes = [
  { name: "claude", fold: (native: Record<string, unknown>) => foldClaudeStdout(initialClaudeProjection, native) },
  { name: "qwen", fold: (native: Record<string, unknown>) => foldStreamJsonStdout(qwenProjectionProfile, initialQwenProjection(), native) },
  { name: "qoder", fold: (native: Record<string, unknown>) => foldStreamJsonStdout(qoderProjectionProfile, initialQoderProjection(), native) },
];
for (const runtime of runtimes) {
test.each([
  { native: {}, projected: {} },
  { native: { user_message_uuid: "last" }, projected: { inputId: "last" } },
  { native: { user_message_uuids: ["first", "last"] }, projected: { inputIds: ["first", "last"] } },
  { native: { user_message_uuid: "last", user_message_uuids: ["first", "last"] }, projected: { inputId: "last", inputIds: ["first", "last"] } },
  { native: { user_message_uuids: [] }, projected: { inputIds: [] } },
])(`${runtime.name} preserves independent, ordered native turn-end identities (%#)`, ({ native, projected }) => {
  const message = { type: "result", subtype: "success", is_error: false, ...native };
  const folded = runtime.fold(message);
  const frames = folded.commands.flatMap((command) => command.kind === "frame" ? [command.body] : []);
  expect(frames[0]?.native).toBe(message);
  expect(frames.flatMap((frame) => frame.events).filter((event) => event.kind === "turn_ended")).toEqual([{ kind: "turn_ended", outcome: { kind: "completed" }, ...projected }]);
});

}
