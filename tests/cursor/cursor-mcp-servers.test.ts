import { expect, test } from "vitest";
import type { McpServer } from "../../packages/oar/src/contracts/session.js";
import { createCursorRuntime } from "../../packages/oar/src/runtimes/cursor/index.js";
import { cursorMcpServers } from "../../packages/oar/src/runtimes/cursor/model.js";
import type { CursorSdk } from "../../packages/oar/src/runtimes/cursor/sdk.js";
import { openFakeCursor } from "../fixtures/fake-cursor-sdk.js";

const servers: readonly McpServer[] = [
  { name: "echo", command: "node", args: ["echo.mjs"], env: { OAR_ECHO_TOKEN: "sample-stdio-credential" } },
  { name: "remote", type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer sample-http-credential" } },
];

test.each([undefined, "agent-old"])("mcpServers reach Agent.create / Agent.resume as the SDK's record, both forms with credentials (resume %s)", async (resume) => {
  const { session, opened } = await openFakeCursor({ model: "composer", mcpServers: servers, ...(resume === undefined ? {} : { resume }) });
  try {
    expect(opened[0]?.how).toBe(resume === undefined ? "create" : "resume");
    expect(opened[0]?.options.mcpServers).toEqual({
      echo: { type: "stdio", command: "node", args: ["echo.mjs"], env: { OAR_ECHO_TOKEN: "sample-stdio-credential" } },
      remote: { type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer sample-http-credential" } },
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
  { name: "local", command: "node", env: { FIXTURE_TOKEN: "sample-entry-value" } },
  { name: "remote", type: "http" as const, url: "http://127.0.0.1:9", headers: { Authorization: "Bearer sample-entry-value" } },
])("redacts credential fields on $name if create or resume throws", async (entry) => {
  const sdk: CursorSdk = {
    Agent: {
      create: async () => { await Promise.resolve(); throw new Error("failed with sample-entry-value"); },
      resume: async () => { await Promise.resolve(); throw new Error("failed with sample-entry-value"); },
      listRuns: async () => { await Promise.resolve(); return { items: [{ model: { id: "composer-2.5" }, createdAt: 1 }] }; },
    },
    Cursor: { models: { list: async () => { await Promise.resolve(); return []; } } },
  };
  const runtime = createCursorRuntime({ sdk: async () => { await Promise.resolve(); return sdk; } });
  const opening = runtime.session({ kind: "available", via: "bundled" }, { cwd: "/w", mcpServers: [entry], resume: "agent-old" });
  await expect(opening).rejects.toThrow(/\[redacted\]/u);
  await expect(opening).rejects.not.toThrow("sample-entry-value");
});

test("neither in-process nor subprocess mode declares mcpServerCredentials refused", () => {
  const inProcess = createCursorRuntime({ sdk: async () => { await Promise.resolve(); throw new Error("unused"); } });
  const subprocess = createCursorRuntime({ execution: "subprocess", sdkModule: "file:///unused.mjs" });
  expect(inProcess.refusedSessionOptions.mcpServerCredentials).toBeUndefined();
  expect(subprocess.refusedSessionOptions.mcpServerCredentials).toBeUndefined();
});
