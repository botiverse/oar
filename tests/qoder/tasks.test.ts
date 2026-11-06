/* oxlint-disable eslint/max-statements -- Assert the complete control and replay sequence together. */
import assert from "node:assert/strict";
import { expect, test } from "vitest";
import capture from "../../experiments/task-controls/evidence/qoder-1.1.83.json" with { type: "json" };
import { initialQoderProjection, qoderProjectionProfile } from "../../packages/oar/src/runtimes/qoder/projection.js";
import { qoderTaskViews } from "../../packages/oar/src/runtimes/qoder/tasks.js";
import { foldStreamJsonStdout } from "../../packages/oar/src/shared/stream-json/projection.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";

test("Qoder real foreground and background task frames survive folding without invented identity", () => {
  let state = initialQoderProjection();
  const observed = [];
  for (const native of capture.evidence) {
    const message = asRecord(native); assert.ok(message !== null);
    const next = foldStreamJsonStdout(qoderProjectionProfile, state, message); ({ state } = next);
    for (const command of next.commands.filter(c => c.kind === "frame")) {
      expect(command.body.native).toStrictEqual(native);
      observed.push(...command.body.events.filter(e => e.kind === "task_started" || e.kind === "task_updated" || e.kind === "task_ended"));
    }
  }
  expect(observed).toMatchSnapshot();
  const starts = observed.filter(e => e.kind === "task_started");
  expect(starts).toHaveLength(3);
  expect(starts.every(e => e.taskType === "agent" && e.background === undefined && e.childSessionId === undefined)).toBe(true);
  expect(observed.filter(e => e.kind === "task_ended").map(e => e.status)).toEqual(["stopped", "stopped", "stopped", "completed"]);
  // The duplicate foreground notifications are distinct native facts.
  expect(observed.filter(e => e.kind === "task_ended" && e.taskId === capture.checks[0]?.taskId)).toHaveLength(2);
});

test("Qoder description progress is projected only on change, including replay", () => {
  let state = initialQoderProjection();
  const first = { type: "system", subtype: "task_started", task_id: "child", task_type: "local_agent", description: "One" };
  const progress = { type: "system", subtype: "task_progress", task_id: "child", description: "Two" };
  const events = [first, progress, progress].map(message => {
    const next = foldStreamJsonStdout(qoderProjectionProfile, state, message); ({ state } = next);
    return next.commands.flatMap(c => c.kind === "frame" ? c.body.events : []);
  });
  expect(events).toEqual([[{ kind: "task_started", taskId: "child", taskType: "agent", nativeType: "local_agent", description: "One" }], [{ kind: "task_updated", taskId: "child", description: "Two" }], []]);
  expect(qoderTaskViews({ subtype: "task_notification", task_id: "child", status: "constructor" }, undefined)).toEqual([]);
  expect(qoderTaskViews({ subtype: "task_started" }, undefined)).toEqual([]);
});
