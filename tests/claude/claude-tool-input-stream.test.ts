/* oxlint-disable max-statements -- Each replay assertion follows the native frame that establishes it. */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { foldClaudeStdout, initialClaudeProjection, type ClaudeProjectionState } from "../../packages/oar/src/runtimes/claude/projection.js";
import { contentBlocks } from "../../packages/oar/src/runtimes/claude/content.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { createSessionKernel } from "../../packages/oar/src/shared/session-kernel.js";
import { initialSessionView, reduceSessionView, viewOf } from "../../packages/oar/src/observe/session-view.js";

// Claude 2.1.292, 2026-10-10, recorded by Lookout against a mock provider
// and the local MCP echo fixture. Paths sanitized; no account involved.
const recording = readFileSync(new URL("../replay/fixtures/claude-tool-input-stream.raw.jsonl", import.meta.url), "utf8")
  .trim().split("\n").map((line) => asRecord(parseJson(line))).filter((row) => row !== null);

function project(previous: ClaudeProjectionState, message: JsonRecord) {
  const { state, commands } = foldClaudeStdout(previous, message);
  expect(commands).toHaveLength(1);
  const [command] = commands;
  assert.ok(command?.kind === "frame");
  expect(command.body.native).toBe(message);
  const native = asRecord(message.event);
  const block = asRecord(native?.content_block);
  const delta = asRecord(native?.delta);
  if (native?.type === "content_block_start" && block?.type === "tool_use") {
    expect(command.body.events).toEqual([{ kind: "tool_call_started", callId: block.id, tool: block.name }]);
  }
  if (delta?.type === "input_json_delta") {
    expect(command.body.events).toHaveLength(1);
    expect(command.body.events[0]).toMatchObject({ kind: "tool_call_input_delta", delta: delta.partial_json });
  }
  return { state, command };
}

test("recorded 20 KB MCP arguments stream once before complete input; the unstreamed child still starts with full input", () => {
  const kernel = createSessionKernel("fixture");
  let state = initialClaudeProjection;
  let live = initialSessionView();
  kernel.rawEvents((record) => { live = reduceSessionView(live, record); });
  let deltas = 0;
  const started = new Set<string>();
  const streamed = new Map<string, string>();
  for (const message of recording) {
    const { state: next, command } = project(state, message);
    state = next;
    for (const event of command.body.events) {
      if (event.kind === "tool_call_started") {
        expect(started.has(event.callId)).toBe(false);
        started.add(event.callId);
        if (command.agentPath.length > 0) { expect(event.input?.length).toBeGreaterThan(20_000); }
      }
      if (event.kind === "tool_call_input_delta") {
        deltas += 1;
        streamed.set(event.callId, (streamed.get(event.callId) ?? "") + event.delta);
      }
      if (event.kind === "tool_call_input") {
        expect(JSON.parse(streamed.get(event.callId) ?? "")).toEqual(JSON.parse(event.input));
        const tool = contentBlocks(message).find((item) => item.id === event.callId);
        expect(event.input).toBe(JSON.stringify(tool?.input));
      }
    }
    kernel.frame(command.body, command);
    const inputEvent = command.body.events.find((event) => event.kind === "tool_call_input_delta" || event.kind === "tool_call_input");
    if (inputEvent !== undefined) {
      const part = live.messages.flatMap((turn) => turn.kind === "turn" ? turn.sections.flatMap((section) => section.parts) : []).find((item) => item.kind === "tool" && item.callId === inputEvent.callId);
      expect(part?.kind).toBe("tool");
      if (inputEvent.kind === "tool_call_input_delta") { expect(part).toMatchObject({ input: streamed.get(inputEvent.callId), inputPartial: true }); }
      else { expect(part).toMatchObject({ input: inputEvent.input }); expect(part).not.toHaveProperty("inputPartial"); }
    }
  }
  expect(started.size).toBe(3);
  expect(deltas).toBe(318);
  expect(state.partials.size).toBe(0);
  expect(live).toEqual(viewOf(kernel.records()));
});

function reader() {
  let state = initialClaudeProjection;
  return (message: JsonRecord) => {
    const { state: next, commands } = foldClaudeStdout(state, message);
    state = next;
    return commands.filter((command) => command.kind === "frame");
  };
}
const stream = (event: JsonRecord, parent: string | null = null): JsonRecord => ({ type: "stream_event", event, parent_tool_use_id: parent });
const start = (index: number, id: string, parent: string | null = null): JsonRecord => stream({ type: "content_block_start", index, content_block: { type: "tool_use", id, name: "echo", input: {} } }, parent);
const delta = (index: number, partial_json: string, parent: string | null = null): JsonRecord => stream({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } }, parent);

test("block indexes and call IDs isolate parallel calls, and early child starts establish nested attribution", () => {
  const read = reader();
  read(stream({ type: "message_start", message: { id: "root-message" } }));
  read(start(0, "parent"));
  read(start(1, "root-other"));
  read(start(0, "nested", "parent"));
  expect(read(delta(0, "root"))[0]?.body.events).toEqual([{ kind: "tool_call_input_delta", callId: "parent", delta: "root" }]);
  expect(read(delta(1, "other"))[0]?.body.events).toEqual([{ kind: "tool_call_input_delta", callId: "root-other", delta: "other" }]);
  const [child] = read(delta(0, "child", "parent"));
  expect(child?.agentPath).toEqual(["parent"]);
  expect(child?.body.events).toEqual([{ kind: "tool_call_input_delta", callId: "nested", delta: "child" }]);
  expect(read(start(0, "grandchild", "nested"))[0]?.agentPath).toEqual(["parent", "nested"]);
  expect(read(delta(9, "unmatched"))[0]?.body.events).toEqual([]);
  expect(read(delta(1, ""))[0]?.body.events).toEqual([{ kind: "tool_call_input_delta", callId: "root-other", delta: "" }]);
});
