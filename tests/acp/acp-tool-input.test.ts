import { expect, test } from "vitest";
import { createAcpProjectionState, projectAcpUpdate } from "../../packages/oar/src/shared/acp/projection.js";
import { classifyTool } from "../../packages/oar/src/observe/tool-activity.js";

// Frames as opencode 1.18.30 sent them on a real turn run through Ferry
// (2026-10-06, issue #147): the opening `tool_call` carries a partial or empty
// `rawInput`, the next `tool_call_update` the arguments.

test("an input absent or partial at the start is reported whole when a later update supplies it", () => {
  const state = createAcpProjectionState();
  expect(projectAcpUpdate(state, { sessionUpdate: "tool_call", toolCallId: "bash-1", title: "bash", kind: "execute", status: "pending", rawInput: { cwd: "/tmp/x" } })).toEqual([
    { kind: "tool_call_started", callId: "bash-1", tool: "bash", input: "{\"cwd\":\"/tmp/x\"}" },
  ]);
  expect(projectAcpUpdate(state, {
    sessionUpdate: "tool_call_update", toolCallId: "bash-1", title: "echo hi > a.txt && cat a.txt", status: "in_progress",
    rawInput: { command: "echo hi > a.txt && cat a.txt", cwd: "/tmp/x" },
  })).toEqual([{ kind: "tool_call_input", callId: "bash-1", input: "{\"command\":\"echo hi > a.txt && cat a.txt\",\"cwd\":\"/tmp/x\"}" }]);

  expect(projectAcpUpdate(state, { sessionUpdate: "tool_call", toolCallId: "read-1", title: "read", kind: "read", status: "pending", rawInput: {} })).toEqual([
    { kind: "tool_call_started", callId: "read-1", tool: "read", input: "{}" },
  ]);
  expect(projectAcpUpdate(state, { sessionUpdate: "tool_call_update", toolCallId: "read-1", title: "read", status: "in_progress", rawInput: { filePath: "/tmp/x/a.txt" } })).toEqual([
    { kind: "tool_call_input", callId: "read-1", input: "{\"filePath\":\"/tmp/x/a.txt\"}" },
  ]);

  // No rawInput at all on the opening frame (kimi's shape): the started record has no input.
  expect(projectAcpUpdate(state, { sessionUpdate: "tool_call", toolCallId: "kimi-1", title: "Bash", kind: "execute", status: "pending" })).toEqual([
    { kind: "tool_call_started", callId: "kimi-1", tool: "Bash" },
  ]);
  expect(projectAcpUpdate(state, { sessionUpdate: "tool_call_update", toolCallId: "kimi-1", status: "in_progress", rawInput: { command: "ls" } })).toEqual([
    { kind: "tool_call_input", callId: "kimi-1", input: "{\"command\":\"ls\"}" },
  ]);
});

test("an input equal to the one last reported is not reported again", () => {
  const state = createAcpProjectionState();
  projectAcpUpdate(state, { sessionUpdate: "tool_call", toolCallId: "t1", title: "bash", status: "pending", rawInput: { cwd: "/tmp/x" } });
  // The same input as the start: nothing new.
  expect(projectAcpUpdate(state, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "pending", rawInput: { cwd: "/tmp/x" } })).toEqual([]);
  const full = { command: "printf ok", cwd: "/tmp/x" };
  expect(projectAcpUpdate(state, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress", rawInput: full })).toEqual([
    { kind: "tool_call_input", callId: "t1", input: "{\"command\":\"printf ok\",\"cwd\":\"/tmp/x\"}" },
  ]);
  // opencode sends the arguments again on the next update (opencode-acp-v1.vendor.json: tools[2] carries tools[1]'s keys).
  expect(projectAcpUpdate(state, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress", rawInput: full, content: [] })).toEqual([]);
  // An update without rawInput says nothing about the input.
  expect(projectAcpUpdate(state, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" })).toEqual([]);
});

test("an ending frame carrying a new input reports the input before the end; none is read after the end", () => {
  const state = createAcpProjectionState();
  projectAcpUpdate(state, { sessionUpdate: "tool_call", toolCallId: "t1", title: "bash", status: "pending" });
  expect(projectAcpUpdate(state, {
    sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawInput: { command: "printf ok" }, rawOutput: { output: "ok" },
  })).toEqual([
    { kind: "tool_call_input", callId: "t1", input: "{\"command\":\"printf ok\"}" },
    { kind: "tool_call_ended", callId: "t1", content: [{ type: "other", value: { output: "ok" } }], result: "ok" },
  ]);
  expect(projectAcpUpdate(state, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawInput: { command: "printf again" } })).toEqual([]);
});

test("a running update carrying a new input and output reports the input, then the progress", () => {
  const state = createAcpProjectionState();
  projectAcpUpdate(state, { sessionUpdate: "tool_call", toolCallId: "t1", title: "bash", status: "pending" });
  expect(projectAcpUpdate(state, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress", rawInput: { command: "ls" }, rawOutput: "a.txt" })).toEqual([
    { kind: "tool_call_input", callId: "t1", input: "{\"command\":\"ls\"}" },
    { kind: "tool_call_progress", callId: "t1", output: "a.txt" },
  ]);
});

test("large JSON input stays parseable and changes after 10,000 characters remain observable", () => {
  const state = createAcpProjectionState();
  const oldString = "x".repeat(12_000);
  const first = { old_string: oldString, new_string: "first", file_path: "/project/large.txt" };
  const second = { ...first, new_string: "second" };
  const started = projectAcpUpdate(state, { sessionUpdate: "tool_call", toolCallId: "large", title: "Edit", status: "in_progress", rawInput: first });
  expect(started).toEqual([{ kind: "tool_call_started", callId: "large", tool: "Edit", input: JSON.stringify(first) }]);
  const input = started[0]?.kind === "tool_call_started" ? started[0].input : undefined;
  expect(classifyTool("codebuddy", "Edit", input)).toEqual({ kind: "edit_file", detail: first.file_path, paths: [first.file_path] });
  expect(projectAcpUpdate(state, { sessionUpdate: "tool_call_update", toolCallId: "large", rawInput: second })).toEqual([
    { kind: "tool_call_input", callId: "large", input: JSON.stringify(second) },
  ]);
  expect(projectAcpUpdate(state, { sessionUpdate: "tool_call_update", toolCallId: "large", rawInput: second })).toEqual([]);
});

test("raw input strings and arrays are not treated as output previews", () => {
  for (const rawInput of ["x".repeat(12_000), [{ type: "text", text: "first", extra: 1 }, { text: "second" }], { text: "same", extra: "keep" }]) {
    const state = createAcpProjectionState();
    const input = typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput);
    expect(projectAcpUpdate(state, { sessionUpdate: "tool_call", toolCallId: "t1", title: "custom", rawInput })).toEqual([
      { kind: "tool_call_started", callId: "t1", tool: "custom", input },
    ]);
  }
});

test("input fields beside unchanged text cause a new snapshot while output keeps its text preview", () => {
  const state = createAcpProjectionState();
  projectAcpUpdate(state, { sessionUpdate: "tool_call", toolCallId: "t1", title: "custom", rawInput: { text: "same", revision: 1 } });
  expect(projectAcpUpdate(state, { sessionUpdate: "tool_call_update", toolCallId: "t1", rawInput: { text: "same", revision: 2 }, rawOutput: { text: "output", extra: 1 } })).toEqual([
    { kind: "tool_call_input", callId: "t1", input: '{"text":"same","revision":2}' },
    { kind: "tool_call_progress", callId: "t1", output: "output" },
  ]);
});
