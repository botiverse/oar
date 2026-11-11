import { expect, test } from "vitest";
import type { McpServer } from "../../packages/oar/src/contracts/session.js";
import { cursorMcpServers } from "../../packages/oar/src/runtimes/cursor/model.js";
import { openFakeCursor } from "../fixtures/fake-cursor-sdk.js";

const TOKEN = "cursor-mcp-test-token-0123456789";
const servers: readonly McpServer[] = [
  { name: "echo", command: "node", args: ["echo.mjs"], env: { OAR_ECHO_TOKEN: TOKEN } },
  { name: "remote", type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: `Bearer ${TOKEN}` } },
];

test.each([undefined, "agent-old"])("mcpServers reach Agent.create / Agent.resume as the SDK's record, both forms (resume %s)", async (resume) => {
  const { session, opened } = await openFakeCursor({ model: "composer", mcpServers: servers, ...(resume === undefined ? {} : { resume }) });
  try {
    expect(opened[0]?.how).toBe(resume === undefined ? "create" : "resume");
    expect(opened[0]?.options.mcpServers).toEqual({
      echo: { type: "stdio", command: "node", args: ["echo.mjs"], env: { OAR_ECHO_TOKEN: TOKEN } },
      remote: { type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: `Bearer ${TOKEN}` } },
    });
  } finally { await session.dispose(); }
});

test("no list, or an empty one, sends no mcpServers", async () => {
  for (const mcpServers of [undefined, []]) {
    // oxlint-disable-next-line no-await-in-loop -- two opens in turn.
    const { session, opened } = await openFakeCursor({ model: "composer", ...(mcpServers === undefined ? {} : { mcpServers }) });
    expect(opened[0]?.options).not.toHaveProperty("mcpServers");
    // oxlint-disable-next-line no-await-in-loop -- closed before the next open.
    await session.dispose();
  }
});

test("a list no runtime can attach is refused before the SDK is asked", () => {
  expect(() => cursorMcpServers([{ name: "a", command: "x" }, { name: "a", command: "y" }])).toThrow(/twice/u);
  expect(() => cursorMcpServers([{ name: "__proto__", command: "x" }])).toThrow(expect.objectContaining({ name: "UnsupportedOptionError", option: "mcpServers" }));
});

test("an MCP credential never reaches the records or a control's answer", async () => {
  const { session, agent } = await openFakeCursor({ model: "composer", mcpServers: servers });
  try {
    agent.refuse = new Error(`MCP server remote failed with Authorization: Bearer ${TOKEN}`);
    const refused = await session.prompt("hi");
    expect(refused.kind).toBe("rejected");
    expect(JSON.stringify(refused)).not.toContain(TOKEN);
    expect(JSON.stringify(session.records())).not.toContain(TOKEN);
  } finally { await session.dispose(); }
});
