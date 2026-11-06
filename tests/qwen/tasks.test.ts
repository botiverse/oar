import { expect, test } from "vitest";
import capture from "../../experiments/task-controls/evidence/qwen-0.26.8.json" with { type: "json" };
import { initialQwenProjection, qwenProjectionProfile } from "../../packages/oar/src/runtimes/qwen/projection.js";
import { qwenTaskViews } from "../../packages/oar/src/runtimes/qwen/tasks.js";
import { foldStreamJsonStdout } from "../../packages/oar/src/shared/stream-json/projection.js";

test("Qwen native task fields are read from data without fabricated child identity or usage", () => {
  const events = capture.frames.flatMap(native => foldStreamJsonStdout(qwenProjectionProfile, initialQwenProjection(), native).commands.flatMap(command => command.kind === "frame" ? command.body.events : []));
  expect(events).toEqual([
    { kind: "task_started", taskId: "general-purpose-spawn", taskType: "agent", nativeType: "general-purpose", description: "Qwen native child", toolCallId: "spawn" },
    { kind: "task_ended", taskId: "general-purpose-spawn", status: "completed" },
  ]);
  expect(qwenTaskViews({ subtype: "task_started", task_id: "wrong-level" })).toEqual([]);
  expect(qwenTaskViews({ subtype: "task_notification", data: { task_id: "task", status: "running" } })).toEqual([]);
});
