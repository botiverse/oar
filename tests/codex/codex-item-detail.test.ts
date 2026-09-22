import assert from "node:assert/strict";
import { describe, expect, test } from "vitest";
import {
  codexItemExitCode,
  codexItemInput,
  codexItemOutput,
} from "../../packages/oar/src/runtimes/codex/item-detail.js";
import { foldCodexNotification, initialCodexProjection } from "../../packages/oar/src/runtimes/codex/projection.js";

// commandExecution item as codex 0.154.0 completed it (scratch run
// 2026-09-22, seq 65): the exit status is its own field, the output is the
// command's, not prefixed with the status.
test("a completed commandExecution carries its exit status as exitCode and its output verbatim", () => {
  const item = { type: "commandExecution", id: "exec-d2567803", command: "/bin/zsh -lc 'node --test; git status --short'", status: "completed", aggregatedOutput: "TAP version 13\n# Subtest: add\nok 1 - add\n", exitCode: 0, durationMs: 120 };
  assert.equal(codexItemExitCode(item), 0);
  assert.equal(codexItemOutput(item), "TAP version 13\n# Subtest: add\nok 1 - add\n");
  const { commands } = foldCodexNotification(initialCodexProjection("thread-1"), "item/completed", { threadId: "thread-1", item });
  assert.deepEqual(commands[0]?.kind === "frame" ? commands[0].body.events : [], [
    { kind: "tool_call_ended", callId: "exec-d2567803", output: "TAP version 13\n# Subtest: add\nok 1 - add\n", result: "ok", exitCode: 0 },
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
          "output": "{"content":[{"type":"text","text":"done"}]}",
        },
      }
    `);
  });
});
