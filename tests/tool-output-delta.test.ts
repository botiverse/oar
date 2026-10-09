/* oxlint-disable eslint/max-statements, eslint/max-lines-per-function -- Each test checks an ordered native/output replay and its complete snapshots. */
import { afterEach, expect, test, vi } from "vitest";
import type { RawEvent, RuntimeEventBody } from "../packages/oar/src/contracts/session.js";
import { foldCodexNotification, initialCodexProjection } from "../packages/oar/src/runtimes/codex/projection.js";
import { foldPiEvent, initialPiProjection } from "../packages/oar/src/runtimes/pi/projection.js";
import { createSessionKernel } from "../packages/oar/src/shared/session-kernel.js";
import { initialSessionView, reduceSessionView, viewOf, type SessionView } from "../packages/oar/src/observe/session-view.js";

function tools(view: SessionView) {
  return view.messages.flatMap((message) => message.kind === "turn" ? message.sections.flatMap((section) => section.parts.flatMap((part) => part.kind === "tool" ? [{ sessionId: section.sessionId, agentPath: section.agentPath, ...part }] : [])) : []);
}

afterEach(() => { vi.useRealTimers(); });

test("successive native Codex chunks accumulate in live and replay views, then a Pi snapshot replaces them", () => {
  vi.useFakeTimers({ now: 0 });
  const kernel = createSessionKernel("root");
  let projection = initialCodexProjection("root");
  const push = (method: string, params: Record<string, unknown>): void => {
    const next = foldCodexNotification(projection, method, { threadId: "root", ...params });
    projection = next.state;
    for (const command of next.commands) { if (command.kind === "frame") { kernel.frame(command.body, command); } }
  };
  let live = initialSessionView();
  kernel.rawEvents((record) => { live = reduceSessionView(live, record); });
  push("item/started", { item: { id: "call", type: "commandExecution", command: "printf chunks" } });
  push("item/commandExecution/outputDelta", { itemId: "call", delta: "first\n" });
  push("item/commandExecution/outputDelta", { itemId: "call", delta: "second\n" });
  expect(tools(live)[0]?.output).toBe("first\nsecond\n");
  expect(kernel.records().flatMap((record) => record.kind === "frame" ? record.body.events.filter((event) => event.kind === "tool_call_progress") : [])).toMatchInlineSnapshot(`
    [
      {
        "callId": "call",
        "kind": "tool_call_progress",
        "outputDelta": "first
    ",
      },
      {
        "callId": "call",
        "kind": "tool_call_progress",
        "outputDelta": "second
    ",
      },
    ]
  `);
  const snapshot = foldPiEvent(initialPiProjection, {
    type: "tool_execution_update", toolCallId: "call", toolName: "bash", args: {},
    partialResult: { content: [{ type: "text", text: "retained window" }], details: {} },
  });
  for (const command of snapshot.commands) { kernel.frame(command.body); }
  expect(tools(live)[0]?.output).toBe('{"content":[{"type":"text","text":"retained window"}],"details":{}}');
  expect(live).toEqual(viewOf(kernel.records()));
  // Replaying the cursor's last record twice must not append its output twice.
  const last = kernel.records().at(-1);
  expect(tools(last === undefined ? live : reduceSessionView(live, last))).toEqual(tools(live));
});

test("delta-only progress creates a partial call; snapshots replace, empty snapshots clear, and end removes previews", () => {
  vi.useFakeTimers({ now: 0 });
  const kernel = createSessionKernel("root");
  const push = (event: RuntimeEventBody): void => { kernel.frame({ type: "progress", native: event, events: [event] }); };
  push({ kind: "tool_call_progress", callId: "call", outputDelta: "first" });
  const previews: (string | undefined)[] = [tools(viewOf(kernel.records()))[0]?.output];
  for (const event of [
    { kind: "tool_call_progress", callId: "call", outputDelta: "+second" },
    { kind: "tool_call_progress", callId: "call", output: "" },
    { kind: "tool_call_progress", callId: "call", outputDelta: "fresh" },
    { kind: "tool_call_progress", callId: "call" },
    { kind: "tool_call_progress", callId: "call", output: "snapshot", outputDelta: "+tail" },
  ] as const) {
    push(event);
    const view = viewOf(kernel.records());
    previews.push(tools(view)[0]?.output);
  }
  expect(previews).toMatchInlineSnapshot(`
    [
      "first",
      "first+second",
      "",
      "fresh",
      "fresh",
      "snapshot+tail",
    ]
  `);
  push({ kind: "tool_call_ended", callId: "call", result: "ok", content: [{ type: "text", text: "final" }] });
  const endedView = viewOf(kernel.records());
  expect(tools(endedView)).toMatchInlineSnapshot(`
    [
      {
        "agentPath": [],
        "callId": "call",
        "content": [
          {
            "text": "final",
            "type": "text",
          },
        ],
        "endedAt": 0,
        "kind": "tool",
        "result": "ok",
        "sessionId": "root",
        "tool": "?",
      },
    ]
  `);
});

test("late deltas keep their ended tool and lane, without reopening it or appending to a child with the same ID", () => {
  vi.useFakeTimers({ now: 0 });
  const kernel = createSessionKernel("root");
  const push = (event: RuntimeEventBody, sessionId = "root"): RawEvent => kernel.frame({ type: "native", native: event, events: [event] }, { sessionId });
  push({ kind: "tool_call_started", callId: "same", tool: "shell" });
  push({ kind: "tool_call_progress", callId: "same", outputDelta: "root-1" });
  push({ kind: "tool_call_started", callId: "same", tool: "shell" }, "child");
  push({ kind: "tool_call_progress", callId: "same", outputDelta: "child-1" }, "child");
  push({ kind: "turn_ended", outcome: { kind: "aborted" } });
  push({ kind: "tool_call_progress", callId: "same", outputDelta: "+root-2" });
  const last = push({ kind: "tool_call_progress", callId: "same", outputDelta: "+child-2" }, "child");
  const view = viewOf(kernel.records());
  expect(tools(view).map((part) => ({ sessionId: part.sessionId, result: part.result, output: part.output }))).toMatchInlineSnapshot(`
    [
      {
        "output": "root-1+root-2",
        "result": "ended",
        "sessionId": "root",
      },
      {
        "output": "child-1+child-2",
        "result": "running",
        "sessionId": "child",
      },
    ]
  `);
  expect(tools(reduceSessionView(view, last))).toEqual(tools(view));
});
