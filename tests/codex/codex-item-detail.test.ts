import assert from "node:assert/strict";
import { describe, expect, test } from "vitest";
import {
  codexItemExitCode,
  codexItemInput,
  codexToolContent,
} from "../../packages/oar/src/runtimes/codex/item-detail.js";
import { toolResultText } from "../../packages/oar/src/observe/tool-output.js";
import { foldCodexNotification, initialCodexProjection } from "../../packages/oar/src/runtimes/codex/projection.js";

function codexItemOutput(item: Record<string, unknown>): string | undefined {
  return toolResultText(codexToolContent(item));
}

// commandExecution item as codex 0.154.0 completed it (scratch run
// 2026-09-22, seq 65): the exit status is its own field, the output is the
// command's, not prefixed with the status.
test("a completed commandExecution carries its exit status as exitCode and its output verbatim", () => {
  const item = { type: "commandExecution", id: "exec-d2567803", command: "/bin/zsh -lc 'node --test; git status --short'", status: "completed", aggregatedOutput: "TAP version 13\n# Subtest: add\nok 1 - add\n", exitCode: 0, durationMs: 120 };
  assert.equal(codexItemExitCode(item), 0);
  assert.equal(codexItemOutput(item), "TAP version 13\n# Subtest: add\nok 1 - add\n");
  const { commands } = foldCodexNotification(initialCodexProjection("thread-1"), "item/completed", { threadId: "thread-1", item });
  assert.deepEqual(commands[0]?.kind === "frame" ? commands[0].body.events : [], [
    { kind: "tool_call_ended", callId: "exec-d2567803", content: [{ type: "text", text: "TAP version 13\n# Subtest: add\nok 1 - add\n" }], result: "ok", exitCode: 0 },
  ]);
});

test("exitCode is absent when the item carries none, null when codex reports a signal exit", () => {
  assert.equal(codexItemExitCode({ type: "commandExecution", status: "declined" }), undefined);
  assert.equal(codexItemExitCode({ type: "commandExecution", status: "failed", exitCode: null }), null);
  assert.equal(codexItemExitCode({ type: "fileChange", status: "completed", exitCode: 0 }), undefined);
  // No output at all: the status is the only detail left.
  assert.equal(codexItemOutput({ type: "commandExecution", status: "declined" }), "declined");
});

describe("codex item diagnostics", () => {

  test("projects command and MCP invocation details", () => {
    expect({
      command: {
        input: codexItemInput({
          type: "commandExecution",
          command: "/tmp/coxswain-say hello",
        }),
        output: codexItemOutput({
          type: "commandExecution",
          exitCode: 0,
          aggregatedOutput: "delivered\n",
        }),
      },
      mcp: {
        input: codexItemInput({
          type: "mcpToolCall",
          arguments: { issue: 42 },
        }),
        output: codexItemOutput({
          type: "mcpToolCall",
          result: { content: [{ type: "text", text: "done" }] },
          error: null,
        }),
      },
    }).toMatchInlineSnapshot(`
      {
        "command": {
          "input": "/tmp/coxswain-say hello",
          "output": "delivered
      ",
        },
        "mcp": {
          "input": "{"issue":42}",
          "output": "done",
        },
      }
    `);
  });
});

test("an MCP result's blocks are its content in order, the whole result without blocks, and an error its message (#73)", () => {
  const image = { type: "image", data: "iVBOR", mimeType: "image/png" };
  expect(codexToolContent({ type: "mcpToolCall", result: { content: [{ type: "text", text: "shot" }, image] } })).toEqual([
    { type: "text", text: "shot" }, { type: "image", mediaType: "image/png", data: "iVBOR" },
  ]);
  const bare = { content: [], structuredContent: { n: 1 } };
  expect(codexToolContent({ type: "mcpToolCall", result: bare })).toEqual([{ type: "other", value: bare }]);
  expect(codexToolContent({ type: "mcpToolCall", result: null, error: { message: "boom" } })).toEqual([{ type: "text", text: "error: boom" }]);
  expect(codexToolContent({ type: "webSearch", results: [{ url: "u" }] })).toEqual([{ type: "other", value: [{ url: "u" }] }]);
});

// A `sleep` item as codex emitted it after "sleep 100" (#83): it ended after 7.5 s of its 50 s when a steer arrived.
test("a sleep item is a sleep tool call with its requested duration as input and no reported result", () => {
  const item = { type: "sleep", id: "call_rorJ", durationMs: 50_000 };
  const started = foldCodexNotification(initialCodexProjection("thread-1"), "item/started", { threadId: "thread-1", item, startedAtMs: 1_791_015_508_662 });
  assert.deepEqual(started.commands[0]?.kind === "frame" ? started.commands[0].body.events : [], [
    { kind: "tool_call_started", callId: "call_rorJ", tool: "sleep", input: "{\"durationMs\":50000}" },
  ]);
  const ended = foldCodexNotification(started.state, "item/completed", { threadId: "thread-1", item, completedAtMs: 1_791_015_516_209 });
  assert.deepEqual(ended.commands[0]?.kind === "frame" ? ended.commands[0].body.events : [], [{ kind: "tool_call_ended", callId: "call_rorJ" }]);
});
