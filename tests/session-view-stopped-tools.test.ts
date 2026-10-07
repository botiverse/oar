import { expect, test } from "vitest";
import { initialSessionView, reduceSessionView, reduceSessionViewEvent, viewOf, type SessionView } from "../packages/oar/src/observe/session-view.js";
import { tasksOf } from "../packages/oar/src/observe/tasks.js";
import { createSessionKernel, type SessionKernel } from "../packages/oar/src/shared/session-kernel.js";

type Ending = "abort fallback" | "dispose" | "turn_ended";
const endings: readonly Ending[] = ["abort fallback", "dispose", "turn_ended"];

function begin(kernel: SessionKernel): void {
  const prompt = kernel.request("toRuntime", { kind: "prompt", input: "work" });
  kernel.respond(prompt.id, { kind: "accepted" });
}

function finish(kernel: SessionKernel, ending: Ending): void {
  if (ending === "turn_ended") {
    kernel.frame({ type: "end", native: {}, events: [{ kind: "turn_ended", outcome: { kind: "completed" } }] });
    return;
  }
  const stop = kernel.request("toRuntime", { kind: ending === "dispose" ? "dispose" : "abort" });
  if (ending === "abort fallback") { kernel.respond(stop.id, { kind: "accepted" }); }
  kernel.respond("", { kind: "exited", code: 9 });
}

function toolsIn(view: SessionView) {
  return view.messages.flatMap((message) => message.kind === "turn"
    ? message.sections.flatMap((section) => section.parts.flatMap((part) => part.kind === "tool"
      ? [{ sessionId: section.sessionId, agentPath: section.agentPath, ...part }]
      : []))
    : []);
}

// oxlint-disable-next-line eslint/max-statements, eslint/max-lines-per-function -- One turn boundary, its untouched checkpoint and the full tool snapshot.
test.each(endings)("%s ends unresolved root tools across display segments, leaving child tools and tasks alone", (ending) => {
  const kernel = createSessionKernel("root");
  begin(kernel);
  kernel.frame({ type: "tools", native: {}, events: [
    { kind: "tool_call_started", callId: "before", tool: "Bash" },
    { kind: "tool_call_progress", callId: "before", output: "partial output" },
    { kind: "tool_call_started", callId: "settled", tool: "Read" },
    { kind: "tool_call_ended", callId: "settled", result: "failed", content: [{ type: "text", text: "missing file" }] },
    { kind: "task_started", taskId: "background", taskType: "shell", background: true },
  ] });
  kernel.frame({ type: "tool", native: {}, events: [{ kind: "tool_call_started", callId: "before", tool: "Bash" }] }, { agentPath: ["child"] });
  kernel.frame({ type: "tool", native: {}, events: [{ kind: "tool_call_started", callId: "before", tool: "Bash" }] }, { sessionId: "child-session" });
  const steer = kernel.request("toRuntime", { kind: "steer", input: "more" });
  kernel.respond(steer.id, { kind: "accepted" });
  kernel.frame({ type: "tool", native: {}, events: [{ kind: "tool_call_started", callId: "after", tool: "Bash" }] });
  const before = viewOf(kernel.records());
  const cursor = kernel.records().length;
  const tasksBefore = tasksOf(kernel.records());
  finish(kernel, ending);
  const after = kernel.records().slice(cursor).reduce((view, record) => reduceSessionView(view, record), structuredClone(before));
  expect(after).toEqual(viewOf(kernel.records()));
  expect(toolsIn(before).filter((part) => part.result === "running")).toHaveLength(4);
  expect(toolsIn(after).map(({ sessionId, agentPath, callId, result, content, output }) => ({ sessionId, agentPath, callId, result, content, output }))).toMatchInlineSnapshot(`
    [
      {
        "agentPath": [],
        "callId": "before",
        "content": undefined,
        "output": "partial output",
        "result": "ended",
        "sessionId": "root",
      },
      {
        "agentPath": [],
        "callId": "settled",
        "content": [
          {
            "text": "missing file",
            "type": "text",
          },
        ],
        "output": undefined,
        "result": "failed",
        "sessionId": "root",
      },
      {
        "agentPath": [
          "child",
        ],
        "callId": "before",
        "content": undefined,
        "output": undefined,
        "result": "running",
        "sessionId": "root",
      },
      {
        "agentPath": [],
        "callId": "before",
        "content": undefined,
        "output": undefined,
        "result": "running",
        "sessionId": "child-session",
      },
      {
        "agentPath": [],
        "callId": "after",
        "content": undefined,
        "output": undefined,
        "result": "ended",
        "sessionId": "root",
      },
    ]
  `);
  expect(toolsIn(after).filter((part) => part.result === "ended").every((part) => part.endedAt === undefined)).toBe(true);
  expect(tasksOf(kernel.records()).value).toEqual(tasksBefore.value);
});

// oxlint-disable-next-line eslint/max-statements -- Keep the boundary and late native records in one sequence.
test.each(endings)("a late tool result after %s replaces the inferred end; progress does not reopen it", (ending) => {
  const kernel = createSessionKernel("root");
  begin(kernel);
  kernel.frame({ type: "tool", native: {}, events: [{ kind: "tool_call_started", callId: "call", tool: "Bash" }] });
  finish(kernel, ending);
  const ended = viewOf(kernel.records());
  kernel.frame({ type: "progress", native: {}, events: [{ kind: "tool_call_progress", callId: "call", output: "late output" }] });
  const progressed = viewOf(kernel.records());
  expect(toolsIn(progressed)[0]).toMatchObject({ result: "ended", output: "late output" });
  kernel.frame({ type: "result", native: {}, events: [{ kind: "tool_call_ended", callId: "call", result: "ok", content: [{ type: "text", text: "actual result" }] }] });
  const final = viewOf(kernel.records());
  expect(final.messages).toHaveLength(ended.messages.length);
  expect(toolsIn(final)[0]).toMatchObject({ result: "ok", content: [{ type: "text", text: "actual result" }] });
  expect(toolsIn(final)[0]?.output).toBeUndefined();
  expect(toolsIn(final)[0]?.endedAt).toEqual(kernel.records().at(-1)?.receivedAt);
});

test.each([{ agentPath: ["child"] }, { sessionId: "child-session" }])("a child turn end and exit do not end the root's tool: %j", (scope) => {
  const kernel = createSessionKernel("root");
  begin(kernel);
  kernel.frame({ type: "tool", native: {}, events: [{ kind: "tool_call_started", callId: "call", tool: "Bash" }] });
  kernel.frame({ type: "end", native: {}, events: [{ kind: "turn_ended", outcome: { kind: "completed" } }] }, scope);
  kernel.respond("", { kind: "exited", code: 0 }, scope);
  const view = viewOf(kernel.records());
  expect(toolsIn(view)[0]?.result).toBe("running");
});

test("ending a new prompt only ends that prompt's tools", () => {
  const kernel = createSessionKernel("root");
  begin(kernel);
  kernel.frame({ type: "tool", native: {}, events: [{ kind: "tool_call_started", callId: "older", tool: "Bash" }] });
  begin(kernel);
  kernel.frame({ type: "tool", native: {}, events: [{ kind: "tool_call_started", callId: "current", tool: "Bash" }] });
  finish(kernel, "turn_ended");
  const view = viewOf(kernel.records());
  expect(toolsIn(view).map((part) => [part.callId, part.result])).toEqual([["older", "running"], ["current", "ended"]]);
});

test.each(["turn_ended", "exited"] as const)("flat %s events also end root tools without inventing their result", (kind) => {
  const env = { sessionId: "root", agentPath: [], receivedAt: 1 };
  const started = reduceSessionViewEvent(initialSessionView(), { ...env, seq: 0, kind: "tool_call_started", callId: "call", tool: "Bash" });
  const ended = reduceSessionViewEvent(started, kind === "exited"
    ? { ...env, seq: 1, kind, code: null }
    : { ...env, seq: 1, kind, outcome: { kind: "completed" } });
  expect(toolsIn(ended)[0]).toMatchInlineSnapshot(`
    {
      "agentPath": [],
      "callId": "call",
      "kind": "tool",
      "result": "ended",
      "sessionId": "root",
      "startedAt": 1,
      "tool": "Bash",
    }
  `);
});
