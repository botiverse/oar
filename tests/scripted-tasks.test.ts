import { expect, test } from "vitest";
import type { Session } from "../packages/oar/src/index.js";
import { tasksOf } from "../packages/oar/src/observe/tasks.js";
import { awaitTurnEnd } from "../packages/oar/src/observe/turns.js";
import { scriptedRuntime, type ScriptedTask } from "../packages/oar/src/testing/index.js";

async function withBackgroundTask(): Promise<{ readonly session: Session; readonly task: ScriptedTask }> {
  const started: ScriptedTask[] = [];
  const session = await scriptedRuntime({ turn: (turn) => {
    started.push(turn.task({ taskType: "shell", description: "sleep 8", background: true }));
    turn.say("started it");
  } }).session({ kind: "available", via: "bundled" }, { cwd: process.cwd() });
  await session.prompt("start a background job");
  await awaitTurnEnd(session);
  const [task] = started;
  if (task === undefined) {
    throw new Error("the script started no task");
  }
  return { session, task };
}

test("a scripted task outlives its turn and ends later without reopening the turn", async () => {
  const { session, task } = await withBackgroundTask();
  expect(tasksOf(session.records()).value).toMatchObject([{ taskId: task.taskId, taskType: "shell", background: true, status: "running" }]);
  task.update({ description: "sleep 8, half way" });
  task.end("completed", { summary: "slept", outputFile: "/tmp/out.txt" });
  task.end("failed");
  expect(tasksOf(session.records()).value).toMatchObject([{ status: "completed", summary: "slept", outputFile: "/tmp/out.txt", description: "sleep 8, half way" }]);
  expect(session.status().value.kind).toBe("idle");
  await session.dispose();
});

test("a scripted task reports nothing after the session is disposed", async () => {
  const { session, task } = await withBackgroundTask();
  await session.dispose();
  const before = session.records().length;
  task.end("completed");
  expect(session.records()).toHaveLength(before);
});
