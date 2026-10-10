/* oxlint-disable max-statements -- Each frame advances the input lifecycle and checks its live/replayed view. */
import { expect, test } from "vitest";
import type { RawEvent, RuntimeEventBody } from "../packages/oar/src/contracts/session.js";
import { createSessionKernel } from "../packages/oar/src/shared/session-kernel.js";
import { statusOf } from "../packages/oar/src/observe/agent-status.js";
import { initialSessionView, reduceSessionView, viewOf, type SessionView } from "../packages/oar/src/observe/session-view.js";

function tools(view: SessionView) {
  return view.messages.flatMap((message) => message.kind === "turn" ? message.sections.flatMap((section) => section.parts.flatMap((part) => part.kind === "tool" ? [{ sessionId: section.sessionId, agentPath: section.agentPath, ...part }] : [])) : []);
}

function fixture() {
  const kernel = createSessionKernel("root");
  const live = { view: initialSessionView() };
  kernel.rawEvents((record) => { live.view = reduceSessionView(live.view, record); });
  const push = (event: RuntimeEventBody, scope: { sessionId?: string; agentPath?: readonly string[] } = {}): RawEvent => kernel.frame({ type: "native", native: event, events: [event] }, scope);
  return { kernel, live, push, parts: () => tools(live.view) };
}

test("tool arguments append verbatim in live and replay views, then complete input replaces them", () => {
  const { kernel, live, push } = fixture();
  push({ kind: "tool_call_started", callId: "call", tool: "show_widget" });
  const pieces = ['{"widget_code":"', String.raw`<svg title=\"你好`, String.raw`\">`, String.raw`\n`, '</svg>"}'];
  let accumulated = "";
  for (const delta of pieces) {
    const last = push({ kind: "tool_call_input_delta", callId: "call", delta });
    accumulated += delta;
    expect(tools(live.view)[0]).toMatchObject({ input: accumulated, inputPartial: true, result: "running" });
    expect(live.view).toEqual(viewOf(kernel.records()));
    expect(tools(reduceSessionView(live.view, last))).toEqual(tools(live.view));
    expect(statusOf(kernel.records()).value).toMatchObject({ kind: "running", phase: { tool: "show_widget", callId: "call" }, lastEventAt: last.receivedAt });
  }
  // A complete snapshot is authoritative even when it differs from the fragments.
  push({ kind: "tool_call_input", callId: "call", input: '{"widget_code":"final"}' });
  expect(tools(live.view)[0]).toMatchObject({ input: '{"widget_code":"final"}', result: "running" });
  expect(tools(live.view)[0]).not.toHaveProperty("inputPartial");
  push({ kind: "tool_call_ended", callId: "call", result: "ok" });
  expect(tools(live.view)).toHaveLength(1);
  expect(tools(live.view)[0]).toMatchObject({ input: '{"widget_code":"final"}', result: "ok" });
  expect(live.view).toEqual(viewOf(kernel.records()));
});

test("a delta without a start renders unknown tool input, including an empty fragment", () => {
  const { parts, push } = fixture();
  push({ kind: "tool_call_input_delta", callId: "call", delta: "" });
  expect(parts()).toEqual([{ sessionId: "root", agentPath: [], kind: "tool", callId: "call", tool: "?", input: "", inputPartial: true, result: "running" }]);
  push({ kind: "tool_call_input_delta", callId: "call", delta: "not valid JSON" });
  expect(parts()[0]?.input).toBe("not valid JSON");
  push({ kind: "tool_call_input", callId: "call", input: "" });
  expect(parts()[0]?.input).toBe("");
  expect(parts()[0]).not.toHaveProperty("inputPartial");
});

test("interleaved inputs keep their session and agent lane; late input never reopens an ended call", () => {
  const { kernel, live, push } = fixture();
  const lanes = [{}, { agentPath: ["child"] }, { sessionId: "other" }];
  for (const scope of lanes) { push({ kind: "tool_call_started", callId: "same", tool: "echo" }, scope); }
  for (const [index, scope] of lanes.entries()) { push({ kind: "tool_call_input_delta", callId: "same", delta: String(index) }, scope); }
  push({ kind: "turn_ended", outcome: { kind: "aborted" } });
  push({ kind: "tool_call_input_delta", callId: "same", delta: "+late" });
  expect(tools(live.view).map((part) => [part.sessionId, part.agentPath, part.input, part.inputPartial, part.result])).toEqual([
    ["root", [], "0+late", true, "ended"], ["root", ["child"], "1", true, "running"], ["other", [], "2", true, "running"],
  ]);
  push({ kind: "tool_call_input", callId: "same", input: "complete" });
  expect(tools(live.view)[0]).toMatchObject({ input: "complete", result: "ended" });
  expect(tools(live.view)[0]).not.toHaveProperty("inputPartial");
  expect(live.view).toEqual(viewOf(kernel.records()));
});
