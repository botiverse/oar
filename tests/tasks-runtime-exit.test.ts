import { expect, test } from "vitest";
import type { RawEvent, RequestBody, ResponseBody, RuntimeEventBody, TaskStatus } from "../packages/oar/src/contracts/session.js";
import { initialTasks, initialTaskState, reduceTasks, reduceTaskState, tasksOf } from "../packages/oar/src/observe/index.js";

const root = { sessionId: "root", agentPath: [] };
interface Scope { readonly sessionId?: string; readonly agentPath?: readonly string[] }

function frame(seq: number, events: RuntimeEventBody[], scope: Scope = {}): RawEvent {
  return { ...root, ...scope, seq, receivedAt: seq * 10, kind: "frame", body: { type: "native", native: {}, events } };
}
function request(seq: number, id: string, body: RequestBody): RawEvent {
  return { ...root, seq, receivedAt: seq * 10, kind: "request", id, direction: "toRuntime", body };
}
function response(seq: number, requestId: string, body: ResponseBody): RawEvent {
  return { ...root, seq, receivedAt: seq * 10, kind: "response", requestId, body };
}
const started = (seq: number, taskId = "task", scope?: Scope): RawEvent =>
  frame(seq, [{ kind: "task_started", taskId, taskType: "shell", background: true }], scope);
const exit = (seq: number, scope?: Scope): RawEvent => ({ ...response(seq, "", { kind: "exited", code: 9 }), ...scope });
const prompt = request(0, "prompt", { kind: "prompt", input: "work" });
const acceptedPrompt = response(1, "prompt", { kind: "accepted" });
const abort = request(3, "abort", { kind: "abort" });
const acceptedAbort = response(4, "abort", { kind: "accepted" });
const dispose = request(3, "dispose", { kind: "dispose" });
const completed = (seq: number): RawEvent => frame(seq, [{ kind: "turn_ended", outcome: { kind: "completed" } }]);

const causes: readonly { name: string; records: readonly RawEvent[]; status: "stopped" | "failed" }[] = [
  { name: "accepted abort", records: [prompt, acceptedPrompt, started(2), abort, acceptedAbort], status: "stopped" },
  { name: "dispose while idle", records: [started(2), dispose], status: "stopped" },
  { name: "unrequested exit", records: [prompt, acceptedPrompt, started(2)], status: "failed" },
  { name: "unanswered abort", records: [prompt, acceptedPrompt, started(2), abort], status: "failed" },
  { name: "refused abort", records: [prompt, acceptedPrompt, started(2), abort, response(4, "abort", { kind: "rejected", code: "runtime_refused", reason: "no" })], status: "failed" },
  { name: "native end before exit after abort", records: [prompt, acceptedPrompt, started(2), abort, acceptedAbort, completed(5)], status: "failed" },
  { name: "native end before exit after dispose", records: [prompt, acceptedPrompt, started(2), dispose, completed(5)], status: "stopped" },
];

test.each(causes)("runtime exit after $name ends unfinished tasks", ({ records, status }) => {
  const before = tasksOf(records);
  expect(before.value[0]?.status).toBe("running");
  const ended = tasksOf([...records, exit(10)]);
  expect(ended.value).toEqual([{ taskId: "task", taskType: "shell", background: true, ...root,
    status, startedAt: 20, endedAt: 100, ...(status === "failed" ? { error: "runtime exited" } : {}) }]);
  expect(ended.seq).toBe(10);
  expect(before.value[0]?.status).toBe("running");
});

test.each(["pending", "running", "paused"] satisfies TaskStatus[])("an unfinished %s task ends at process exit", (status) => {
  const records = [started(0), frame(1, [{ kind: "task_updated", taskId: "task", status }]), exit(2)];
  expect(tasksOf(records).value[0]).toMatchInlineSnapshot(`
    {
      "agentPath": [],
      "background": true,
      "endedAt": 20,
      "error": "runtime exited",
      "sessionId": "root",
      "startedAt": 0,
      "status": "failed",
      "taskId": "task",
      "taskType": "shell",
    }
  `);
});

test.each(["completed", "failed", "stopped"] as const)("a task already %s stays unchanged at exit", (status) => {
  const records = [started(0), frame(1, [{ kind: "task_ended", taskId: "task", status, summary: "native end", outputFile: "/tmp/result" }])];
  expect(tasksOf([...records, dispose, exit(10)]).value).toEqual(tasksOf(records).value);
});

test("root exit ends tasks of child sessions and agents in the same stream; child exits do not", () => {
  const records = [started(0), started(1, "child", { sessionId: "child" }), started(2, "nested", { agentPath: ["worker"] }),
    exit(3, { sessionId: "child" }), exit(4, { agentPath: ["worker"] })];
  expect(tasksOf(records).value.map((task) => task.status)).toEqual(["running", "running", "running"]);
  const after = tasksOf([...records, exit(5)]);
  expect(after.value.map((task) => [task.taskId, task.sessionId, task.agentPath, task.status, task.endedAt, task.error])).toEqual([
    ["task", "root", [], "failed", 50, "runtime exited"],
    ["child", "child", [], "failed", 50, "runtime exited"],
    ["nested", "root", ["worker"], "failed", 50, "runtime exited"],
  ]);
});

test.each(["aborted", "completed"] as const)("a native %s turn end leaves background tasks running while the runtime lives", (kind) => {
  const records = [prompt, acceptedPrompt, started(2), abort, acceptedAbort,
    frame(5, [{ kind: "turn_ended", outcome: { kind } }])];
  expect(tasksOf(records).value[0]?.status).toBe("running");
  expect(tasksOf([...records, exit(6)]).value[0]?.status).toBe("failed");
});

test.each(causes)("a late native task end overrides the inferred end after $name", ({ records }) => {
  const after = tasksOf([...records, exit(10), frame(11, [{ kind: "task_ended", taskId: "task", status: "completed", summary: "native result" }])]);
  expect(after.value[0]).toMatchInlineSnapshot(`
    {
      "agentPath": [],
      "background": true,
      "endedAt": 110,
      "sessionId": "root",
      "startedAt": 20,
      "status": "completed",
      "summary": "native result",
      "taskId": "task",
      "taskType": "shell",
    }
  `);
});

test("a late native running update reopens a task without its inferred exit error or time", () => {
  const after = tasksOf([started(0), exit(1), frame(2, [{ kind: "task_updated", taskId: "task", status: "running", description: "still alive" }])]);
  expect(after.value[0]).toMatchInlineSnapshot(`
    {
      "agentPath": [],
      "background": true,
      "description": "still alive",
      "sessionId": "root",
      "startedAt": 0,
      "status": "running",
      "taskId": "task",
      "taskType": "shell",
    }
  `);
});

test("child dispose and accepted abort do not mark root exit stopped", () => {
  const child = { sessionId: "child" };
  const records = [prompt, acceptedPrompt, started(2), { ...request(3, "dispose", { kind: "dispose" }), ...child },
    { ...request(4, "abort", { kind: "abort" }), ...child }, { ...response(5, "abort", { kind: "accepted" }), ...child }, exit(6)];
  expect(tasksOf(records).value[0]?.status).toBe("failed");
});

test.each(causes)("incremental checkpoints retain the evidence for $name", ({ records, status }) => {
  let state = initialTaskState();
  for (const record of records) { state = reduceTaskState(structuredClone(state), record); }
  const before = structuredClone(state);
  const after = reduceTaskState(state, exit(10));
  expect([...after.tasks.values()]).toEqual(tasksOf([...records, exit(10)]).value);
  expect(after.tasks.get("task")?.status).toBe(status);
  expect(state).toEqual(before);
});

test("an explicit root id lets a checkpoint begin with a child record", () => {
  const records = [started(0, "child", { sessionId: "child" }), exit(1, { sessionId: "child" }), dispose, exit(4)];
  const state = records.reduce((previous, record) => reduceTaskState(previous, record), initialTaskState("root"));
  expect(state.tasks.get("child")?.status).toBe("stopped");
  expect(state.tasks.get("child")?.endedAt).toBe(40);
  expect([...state.tasks.values()]).toEqual(tasksOf(records, "root").value);
});

test.each(["accepted", "pending"])("the previous turn's %s abort does not stop a new turn's tasks", (answer) => {
  const records = [prompt, acceptedPrompt, abort, ...(answer === "accepted" ? [acceptedAbort] : []), completed(5),
    request(6, "next", { kind: "prompt", input: "again" }), response(7, "next", { kind: "accepted" }),
    started(8), ...(answer === "pending" ? [response(9, "abort", { kind: "accepted" })] : []), exit(10)];
  expect(tasksOf(records).value[0]?.status).toBe("failed");
});

test("the event-only reducer keeps its existing task rows at exit", () => {
  const records = [prompt, acceptedPrompt, started(2), abort, acceptedAbort];
  const tasks = records.reduce((previous, record) => reduceTasks(previous, record), initialTasks);
  expect(reduceTasks(tasks, exit(5))).toBe(tasks);
  expect(tasks.get("task")?.status).toBe("running");
  expect(tasksOf([...records, exit(5)]).value[0]?.status).toBe("stopped");
});

test.each(["native failure", "runtime exited"])("an existing native error survives exit and later completion: %s", (nativeError) => {
  const state = [started(0), frame(1, [{ kind: "task_updated", taskId: "task", error: nativeError }]), exit(2)]
    .reduce((previous, record) => reduceTaskState(previous, record), initialTaskState());
  expect(state.tasks.get("task")?.error).toBe(nativeError);
  expect(state.exitErrors.has("task")).toBe(false);
  const ended = reduceTaskState(structuredClone(state), frame(3, [{ kind: "task_ended", taskId: "task", status: "completed" }]));
  expect(ended.tasks.get("task")?.error).toBe(nativeError);
  expect(ended.tasks.get("task")?.status).toBe("completed");
});

test.each(["native failure", "runtime exited"])("a late native error replaces inferred error provenance: %s", (nativeError) => {
  const inferred = [started(0), exit(1)].reduce((previous, record) => reduceTaskState(previous, record), initialTaskState());
  const reported = reduceTaskState(structuredClone(inferred), frame(2, [{ kind: "task_updated", taskId: "task", error: nativeError }]));
  expect(reported.exitErrors.has("task")).toBe(false);
  const ended = reduceTaskState(structuredClone(reported), frame(3, [{ kind: "task_ended", taskId: "task", status: "completed" }]));
  expect(ended.tasks.get("task")?.error).toBe(nativeError);
  expect(inferred.exitErrors.has("task")).toBe(true);
});

test("metadata-only updates retain inferred failure until a native status arrives, across checkpoints", () => {
  const inferred = [started(0), exit(1)].reduce((previous, record) => reduceTaskState(previous, record), initialTaskState());
  const described = reduceTaskState(structuredClone(inferred), frame(2, [{ kind: "task_updated", taskId: "task", description: "more detail" }]));
  expect(described.tasks.get("task")?.error).toBe("runtime exited");
  expect(described.exitErrors.has("task")).toBe(true);
  const reported = reduceTaskState(structuredClone(described), frame(3, [{ kind: "task_updated", taskId: "task", status: "completed" }]));
  expect(reported.tasks.get("task")?.error).toBeUndefined();
  expect(reported.tasks.get("task")?.description).toBe("more detail");
  expect(reported.exitErrors.has("task")).toBe(false);
  expect(described.tasks.get("task")?.status).toBe("failed");
});

test("a fresh runtime fold does not inherit the previous process's dispose", () => {
  const earlierRuntime = [started(0), dispose, exit(4)].reduce((previous, record) => reduceTaskState(previous, record), initialTaskState("root"));
  const fresh = [started(0, "new"), exit(1)].reduce((previous, record) => reduceTaskState(previous, record), { ...initialTaskState("root"), tasks: earlierRuntime.tasks });
  expect(fresh.tasks.get("task")).toEqual(earlierRuntime.tasks.get("task"));
  expect(fresh.tasks.get("new")?.status).toBe("failed");
});
