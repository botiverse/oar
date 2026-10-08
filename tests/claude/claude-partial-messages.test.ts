/* oxlint-disable max-statements, max-params -- Fixtures retain the native frame order and explicit child attribution. */
import { expect, test } from "vitest";
import { coalesceText } from "../../packages/oar/src/observe/events.js";
import { foldClaudeStdout, initialClaudeProjection } from "../../packages/oar/src/runtimes/claude/projection.js";
import type { Event, RuntimeEventBody } from "../../packages/oar/src/contracts/session.js";
import type { JsonRecord } from "../../packages/oar/src/shared/json.js";

function reader() {
  let state = initialClaudeProjection;
  return (message: JsonRecord): readonly RuntimeEventBody[] => {
    const next = foldClaudeStdout(state, message);
    ({ state } = next);
    const frames = next.commands.filter((command) => command.kind === "frame");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.body.native).toBe(message);
    return frames.flatMap((frame) => frame.body.events);
  };
}
const partial = (event: JsonRecord, parent: string | null = null): JsonRecord => ({ type: "stream_event", event, parent_tool_use_id: parent });
const start = (id: string, parent: string | null = null): JsonRecord => partial({ type: "message_start", message: { id } }, parent);
const block = (index: number, type: string, parent: string | null = null): JsonRecord => partial({ type: "content_block_start", index, content_block: { type } }, parent);
const delta = (index: number, type: string, value: string, parent: string | null = null): JsonRecord => partial({ type: "content_block_delta", index, delta: { type: `${type}_delta`, [type]: value } }, parent);
const final = (id: string, content: JsonRecord[], parent: string | null = null): JsonRecord => ({ type: "assistant", message: { id, content }, parent_tool_use_id: parent });

test("native deltas arrive before the final block without repeating text or reasoning", () => {
  const read = reader();
  expect(read(start("m1"))).toEqual([]);
  read(block(0, "thinking"));
  expect(read(delta(0, "thinking", "Let me think."))).toEqual([{ kind: "reasoning", content: { kind: "text", text: "Let me think." }, messageId: "m1" }]);
  expect(read(final("m1", [{ type: "thinking", thinking: "Let me think." }]))).toEqual([]);
  expect(read(partial({ type: "content_block_stop", index: 0 }))).toEqual([]);
  read(block(1, "text"));
  expect(read(delta(1, "text", "Alpha"))).toEqual([{ kind: "text_delta", text: "Alpha", messageId: "m1" }]);
  expect(read(delta(1, "text", " beta"))).toEqual([{ kind: "text_delta", text: " beta", messageId: "m1" }]);
  expect(read(final("m1", [{ type: "text", text: "Alpha beta" }]))).toEqual([]);
  // Claude repeats the same API id for separate completed blocks.
  read(block(2, "text"));
  read(delta(2, "text", "Alpha beta"));
  expect(read(final("m1", [{ type: "text", text: "Alpha beta" }]))).toEqual([]);
});

test("tool JSON and signatures stay raw; tool calls start once with complete input", () => {
  const read = reader();
  read(start("m2"));
  read(block(0, "tool_use"));
  expect(read(partial({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":' } }))).toEqual([]);
  expect(read(partial({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "opaque" } }))).toEqual([]);
  expect(read(final("m2", [{ type: "tool_use", id: "call-1", name: "Bash", input: { command: "true" } }]))).toEqual([
    { kind: "tool_call_started", callId: "call-1", tool: "Bash", input: '{"command":"true"}' },
  ]);
});

test("root and child messages keep independent partial state, including after root completion", () => {
  const read = reader();
  read(start("root"));
  read(block(0, "text"));
  read(start("child", "task-1"));
  read(block(0, "text", "task-1"));
  expect(read(delta(0, "text", "root"))).toEqual([{ kind: "text_delta", text: "root", messageId: "root" }]);
  expect(read(delta(0, "text", "child", "task-1"))).toEqual([{ kind: "text_delta", text: "child", messageId: "child" }]);
  read({ type: "result" });
  expect(read(final("child", [{ type: "text", text: "child" }], "task-1"))).toEqual([]);
  expect(read(final("root", [{ type: "text", text: "root" }]))).toEqual([]);
  read(start("next"));
  read(block(0, "text"));
  expect(read(delta(0, "text", "root"))).toEqual([{ kind: "text_delta", text: "root", messageId: "next" }]);
});

test("unstreamed content, redaction and empty thinking survive; a final suffix is not lost", () => {
  const read = reader();
  expect(read(final("plain", [{ type: "text", text: "normal" }, { type: "thinking", thinking: "" }, { type: "redacted_thinking", data: "opaque" }]))).toEqual([
    { kind: "text_delta", text: "normal", messageId: "plain" },
    { kind: "reasoning", content: { kind: "empty" }, messageId: "plain" },
    { kind: "reasoning", content: { kind: "redacted" }, messageId: "plain" },
  ]);
  read(start("partial"));
  read(block(0, "text"));
  read(delta(0, "text", "first"));
  expect(read(final("partial", [{ type: "text", text: "first last" }]))).toEqual([{ kind: "text_delta", text: " last", messageId: "partial" }]);
});


test("coalesced reasoning respects the same message identity boundary as text", () => {
  const events: Event[] = [];
  const observer = coalesceText((event) => { events.push(event); });
  for (const [seq, [messageId, text]] of [["m1", "Think"], ["m1", " more"], ["m2", "Next"]].entries()) {
    observer({ kind: "reasoning", content: { kind: "text", text: text ?? "" }, messageId: messageId ?? "", sessionId: "s", agentPath: [], seq, receivedAt: seq });
  }
  observer({ kind: "turn_ended", outcome: { kind: "completed" }, sessionId: "s", agentPath: [], seq: 3, receivedAt: 3 });
  expect(events.filter((event) => event.kind === "reasoning").map((event) => [event.messageId, event.content])).toEqual([
    ["m1", { kind: "text", text: "Think more" }], ["m2", { kind: "text", text: "Next" }],
  ]);
});


test("message_stop releases only its agent's partial state and preserves the native boundary", () => {
  let state = initialClaudeProjection;
  for (const message of [start("root"), block(0, "text"), delta(0, "text", "root"), start("child", "task-1"), block(0, "text", "task-1"), delta(0, "text", "child", "task-1")]) {
    ({ state } = foldClaudeStdout(state, message));
  }
  expect(state.partials.size).toBe(2);
  ({ state } = foldClaudeStdout(state, final("root", [{ type: "text", text: "root" }])));
  const boundary = partial({ type: "message_stop" });
  const stopped = foldClaudeStdout(state, boundary);
  expect([...stopped.state.partials.keys()]).toEqual(['["task-1"]']);
  expect(stopped.commands).toEqual([{ kind: "frame", agentPath: [], body: { type: "stream_event", native: boundary, events: [] } }]);
  const child = foldClaudeStdout(stopped.state, final("child", [{ type: "text", text: "child" }], "task-1"));
  expect(child.commands.filter((command) => command.kind === "frame").flatMap((command) => command.body.events)).toEqual([]);
  const done = foldClaudeStdout(child.state, partial({ type: "message_stop" }, "task-1"));
  expect(done.state.partials.size).toBe(0);
  ({ state } = done);
  const nextEvents: RuntimeEventBody[] = [];
  for (const message of [start("next"), block(0, "text"), delta(0, "text", "root"), final("next", [{ type: "text", text: "root" }]), boundary]) {
    const next = foldClaudeStdout(state, message);
    ({ state } = next);
    nextEvents.push(...next.commands.filter((command) => command.kind === "frame").flatMap((command) => command.body.events));
  }
  expect(nextEvents).toEqual([{ kind: "text_delta", text: "root", messageId: "next" }]);
  expect(state.partials.size).toBe(0);
});
