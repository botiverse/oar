import { expect, test } from "vitest";
import { claudeMcpCatalog } from "../sea-trial/vendor/support/claude-tools.js";

// Minimal native announcement shapes from Claude 2.1.304, stripped of its
// environment, instructions, paths and request metadata.
const added = (names: readonly string[]): string => `The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded:\n${names.join("\n")}\n\n`;
const removed = (names: readonly string[]): string => `The following deferred tools are no longer available (their MCP server disconnected). Do not search for them:\n${names.join("\n")}\n\n`;

test("withdrawn names leave the searchable catalog while loaded schemas and historical text stay separate", () => {
  expect(claudeMcpCatalog({
    tools: [{ name: "mcp__probe__alpha", defer_loading: true }, { name: "ToolSearch" }],
    messages: [
      { role: "system", content: [{ type: "text", text: `Environment omitted\n\n${added(["Read", "mcp__probe__alpha", "mcp__probe__unused"])}` }] },
      { role: "assistant", content: [{ type: "text", text: added(["mcp__probe__hallucinated"]) }] },
      { role: "user", content: [{ type: "tool_result", content: added(["mcp__probe__result"]) }] },
      { role: "user", content: `${added(["mcp__probe__beta"])}${removed(["mcp__probe__alpha", "mcp__probe__unused"])}` },
      { role: "user", content: "I mentioned mcp__probe__unused; this is not a catalog." },
    ],
  })).toMatchInlineSnapshot(`
    {
      "schemas": [
        "mcp__probe__alpha",
      ],
      "searchable": [
        "mcp__probe__beta",
      ],
    }
  `);
});

test("a later native announcement can make a removed tool searchable again", () => {
  expect(claudeMcpCatalog({
    system: [{ type: "text", text: added(["mcp__probe__alpha"]) }],
    messages: [
      { role: "user", content: removed(["mcp__probe__alpha"]) },
      { role: "user", content: added(["mcp__probe__alpha"]) },
    ],
  })).toEqual({ schemas: [], searchable: ["mcp__probe__alpha"] });
});
