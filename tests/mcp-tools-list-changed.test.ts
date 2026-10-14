import { expect, test } from "vitest";
import { allRuntimes } from "../sea-trial/harness/runtimes.js";

// #399: measured per runtime by sea-trial/vendor/mcp-tools-list-changed.vendor.test.ts.
test("the declarations say how a running session takes a change to an MCP server's tools", () => {
  const declared = Object.fromEntries(allRuntimes.list().map((runtime) => [runtime.id, runtime.mcpToolsListChanged ?? null]));
  expect(declared).toEqual({
    antigravity: "full",
    claude: "additions",
    codex: "none",
    cursor: null,
    grok: "none",
    kimi: "none",
    opencode: "full",
    pi: "full",
  });
  // A runtime that takes no mcpServers declares nothing.
  for (const runtime of allRuntimes.list().filter((candidate) => candidate.refusedSessionOptions?.mcpServers !== undefined)) {
    expect(runtime.mcpToolsListChanged, runtime.id).toBeUndefined();
  }
});
