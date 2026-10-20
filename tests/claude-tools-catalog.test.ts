import { expect, test } from "vitest";
import { claudeMcpCatalog, claudePromptRequest, claudeToolResult, claudeToolResultRequest } from "../sea-trial/vendor/support/claude-tools.js";

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

test("catalog observations follow the prompt and call id despite startup probes and unrelated model requests", () => {
  const prompt = { role: "user", content: [{ type: "text", text: "ALPHA_ROUND" }] };
  const initial = { messages: [prompt], tools: [{ name: "ToolSearch" }] };
  const result = { type: "tool_result", tool_use_id: "search_ALPHA", content: [{ type: "tool_reference", tool_name: "mcp__probe__alpha" }] };
  const loaded = {
    messages: [prompt, { role: "assistant", content: [{ type: "tool_use", id: "search_ALPHA", name: "ToolSearch" }] }, { role: "user", content: [result] }],
    tools: [{ name: "mcp__probe__alpha", defer_loading: true }],
  };
  const raw = [
    { path: "/api/hello", body: null },
    { path: "/v1/messages/count_tokens", body: loaded },
    { path: "/v1/messages", body: { messages: [prompt, { role: "assistant", content: "old answer" }, { role: "user", content: "Name this session" }] } },
    { path: "/v1/messages?beta=true", body: initial },
    { path: "/api/hello", body: null },
    { path: "/v1/messages?beta=true", body: loaded },
    { path: "/v1/messages", body: { messages: [{ role: "user", content: "Unrelated side request" }] } },
  ];

  expect(claudePromptRequest(raw, "ALPHA_ROUND")).toBe(initial);
  expect(claudeToolResultRequest(raw, "search_ALPHA")).toBe(loaded);
  expect(claudeToolResult(raw, "search_ALPHA")).toEqual(result.content);
  expect(claudePromptRequest(raw, "ABSENT_ROUND")).toBeUndefined();
  expect(claudeToolResultRequest(raw, "absent_call")).toBeUndefined();
});
