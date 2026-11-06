import { expect, test } from "vitest";
import type { RawEvent } from "../../packages/oar/src/index.js";
import { tasksOf } from "../../packages/oar/src/observe/tasks.js";
import { foldDsh, initialDshProjection } from "../../packages/oar/src/runtimes/dsh/projection.js";
import type { JsonRecord } from "../../packages/oar/src/shared/json.js";

function record(type: string, data: JsonRecord, options: { readonly sessionId?: string; readonly seq?: number } = {}): RawEvent {
  const { sessionId = "root", seq = 0 } = options;
  const event = { type, seq, time: seq, data };
  const folded = foldDsh(initialDshProjection("root"), { type: "native", channel: "session/event", sessionId, event });
  expect(folded.frame.body.native).toBe(event);
  return { kind: "frame", sessionId: folded.frame.sessionId ?? "root", seq, receivedAt: seq, agentPath: [], body: folded.frame.body };
}

const registered = { jobId: "bash-job", owner: "root", kind: "bash", label: "waiting command", startedAt: 10, toolCall: { callId: "nested-call", rootCallId: "root-call" } };

test.each(["bash", "pwsh"])("%s jobs remain running across a root turn end until their own settlement", kind => {
  const start = record("job/registered", { ...registered, kind });
  const end = record("turn/end", { turn: 1, reason: { kind: "completed" } }, { seq: 1 });
  expect(tasksOf([start, end]).value).toEqual([{ taskId: "bash-job", sessionId: "root", agentPath: [], taskType: "shell", nativeType: kind,
    description: "waiting command", toolCallId: "nested-call", status: "running", startedAt: 0 }]);
  const settled = record("job/settled", { ...registered, status: "completed", detail: "exit code: 0" }, { seq: 2 });
  expect(tasksOf([start, end, settled]).value).toMatchObject([{ taskId: "bash-job", status: "completed", summary: "exit code: 0", endedAt: 2 }]);
});

test.each([["completed", "completed"], ["failed", "failed"], ["killed", "stopped"]])("native %s settlement reports %s, including a missing start", (native, status) => {
  const result = tasksOf([record("job/settled", { ...registered, status: native, cause: "teardown", producerReported: false })]);
  expect(result.value).toMatchObject([{ taskId: "bash-job", status }]);
});

test("a child owns its jobs, while copied history does not transfer ownership", () => {
  expect(tasksOf([record("job/registered", { ...registered, owner: "child" }, { sessionId: "child" })], "root").value).toMatchObject([{ sessionId: "child", taskType: "shell" }]);
  expect(tasksOf([record("job/registered", registered, { sessionId: "copy" }), record("job/settled", { ...registered, status: "completed" }, { sessionId: "copy" })], "root").value).toEqual([]);
});

test("unknown producers keep their native kind without a guessed background flag", () => {
  expect(tasksOf([record("job/registered", { jobId: "future-job", owner: "root", kind: "future" })]).value).toEqual([
    { taskId: "future-job", sessionId: "root", agentPath: [], taskType: "other", nativeType: "future", status: "running", startedAt: 0 },
  ]);
});

test("unknown outcomes and malformed identities stay raw, without a fabricated task result", () => {
  for (const data of [{ ...registered, status: "future" }, { owner: "root", status: "completed" }, { jobId: "j", status: "completed" }]) {
    expect(tasksOf([record("job/settled", data)]).value).toEqual([]);
  }
});
