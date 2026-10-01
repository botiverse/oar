import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import type { RawEvent, RuntimeEventBody } from "../packages/oar/src/contracts/session.js";
import { tasksOf } from "../packages/oar/src/observe/tasks.js";
import { claudePrompted, foldClaudeStdout, initialClaudeProjection } from "../packages/oar/src/runtimes/claude/projection.js";
import { asRecord, parseJson } from "../packages/oar/src/shared/json.js";

/** The recorded claude stream (a background command and a background subagent) as records. */
function fixtureLines(): string[] {
  return readFileSync(path.join(import.meta.dirname, "replay", "fixtures", "claude-background-tasks.raw.jsonl"), "utf8")
    .split("\n").filter((line) => line.trim() !== "");
}

function claudeRecords(): RawEvent[] {
  let state = claudePrompted(initialClaudeProjection);
  const records: RawEvent[] = [];
  for (const line of fixtureLines()) {
    const folded = foldClaudeStdout(state, asRecord(parseJson(line)) ?? {});
    ({ state } = folded);
    const frames = folded.commands.filter((command) => command.kind === "frame");
    records.push(...frames.map((command): RawEvent => ({
      kind: "frame", sessionId: "s", agentPath: command.agentPath, seq: records.length, receivedAt: records.length, body: command.body,
    })));
  }
  return records;
}

test("claude's background command and subagent read as two tasks with their ends", () => {
  const { value } = tasksOf(claudeRecords());
  expect(value).toMatchObject([
    { taskId: "bdc6lp8wy", taskType: "shell", nativeType: "local_bash", background: true, status: "stopped", summary: "Sleep 8 seconds then print done" },
    { taskId: "a8f6763441bcda20c", taskType: "agent", nativeType: "local_agent", background: true, status: "completed", toolCallId: "toolu_017rmJ9ug4RCsCDqB31JdQVA" },
  ]);
});

function frame(seq: number, events: RuntimeEventBody[]): RawEvent {
  return { kind: "frame", sessionId: "root", agentPath: [], seq, receivedAt: seq * 10, body: { type: "item/completed", native: {}, events } };
}

test("a codex subagent given more work after it completed reads as running again", () => {
  const { value } = tasksOf([
    frame(0, [{ kind: "task_started", taskId: "child", taskType: "agent", childSessionId: "child", description: "/root/helper" }]),
    frame(1, [{ kind: "task_ended", taskId: "child", status: "completed" }]),
    frame(2, [{ kind: "task_updated", taskId: "child", status: "running" }]),
  ]);
  expect(value).toEqual([{
    taskId: "child", sessionId: "root", agentPath: [], taskType: "agent", childSessionId: "child", description: "/root/helper",
    status: "running", startedAt: 0,
  }]);
});

test("a report about a task whose start the stream lacks still makes a row", () => {
  const { value } = tasksOf([frame(0, [{ kind: "task_ended", taskId: "late", status: "failed" }])]);
  expect(value).toMatchObject([{ taskId: "late", taskType: "other", status: "failed", endedAt: 0 }]);
});

test("a task started again is a fresh row, not its old end", () => {
  const { value } = tasksOf([
    frame(0, [{ kind: "task_started", taskId: "t", taskType: "agent" }]),
    frame(1, [{ kind: "task_ended", taskId: "t", status: "completed", summary: "done" }]),
    frame(2, [{ kind: "task_started", taskId: "t", taskType: "agent", background: true }]),
  ]);
  expect(value).toEqual([{ taskId: "t", sessionId: "root", agentPath: [], taskType: "agent", background: true, status: "running", startedAt: 20 }]);
});
