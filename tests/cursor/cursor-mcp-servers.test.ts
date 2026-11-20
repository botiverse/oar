import { expect, test } from "vitest";
import type { McpServer } from "../../packages/oar/src/contracts/session.js";
import { cursorMcpServers } from "../../packages/oar/src/runtimes/cursor/model.js";
import { openFakeCursor } from "../fixtures/fake-cursor-sdk.js";

const servers: readonly McpServer[] = [
  { name: "echo", command: "node", args: ["echo.mjs"] },
  { name: "remote", type: "http", url: "http://127.0.0.1:9/mcp" },
];

test.each([undefined, "agent-old"])("mcpServers reach Agent.create / Agent.resume as the SDK's record, both forms (resume %s)", async (resume) => {
  const { session, opened } = await openFakeCursor({ model: "composer", mcpServers: servers, ...(resume === undefined ? {} : { resume }) });
  try {
    expect(opened[0]?.how).toBe(resume === undefined ? "create" : "resume");
    expect(opened[0]?.options.mcpServers).toEqual({
      echo: { type: "stdio", command: "node", args: ["echo.mjs"] },
      remote: { type: "http", url: "http://127.0.0.1:9/mcp" },
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

test.each([
  { name: "local", command: "node", env: { FIXTURE: "sample-entry-value" } },
  { name: "remote", type: "http" as const, url: "http://127.0.0.1:9", headers: { Authorization: "sample-entry-value" } },
])("refuses credential fields on $name before create or resume", async (entry) => {
  const opening = openFakeCursor({ mcpServers: [entry], resume: "agent-old" });
  await expect(opening).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "mcpServers" });
  await expect(opening).rejects.not.toThrow("sample-entry-value");
});
