import { describe, expect, test } from "vitest";
import {
  codexItemInput,
  codexItemOutput,
} from "../../packages/oar/src/runtimes/codex/item-detail.js";

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
          "output": "exit 0
      delivered
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
