import { inspect } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import type { McpServer } from "../../packages/oar/src/contracts/session.js";
import { bundled, fakeCursorRuntime, responsesOf, until } from "../fixtures/cursor-subprocess.js";

afterEach(() => { vi.unstubAllEnvs(); });

/*
 * The one-shot calls redact their answers and errors with the credentials in
 * the call's own `env`, as sessions do with theirs: also a key that does not
 * look like a token, also in an error's `cause` and in a child's stderr tail.
 * The fake SDK leaks the value into its error and stderr (`OAR_FAKE_LEAK`),
 * or exits with it on stderr (`OAR_FAKE_LEAK=exit`).
 */

const KEY = "plain cursor key 4815162342";
const SECRET = "plain status secret 2718281828";

function everything(value: unknown): string {
  return inspect(value, { depth: 20, showHidden: true });
}

async function listingError(leak: "throw" | "exit"): Promise<unknown> {
  try {
    await fakeCursorRuntime("subprocess").listModels(bundled, { env: { CURSOR_API_KEY: KEY, OAR_FAKE_LEAK: leak } });
  } catch (error) {
    return error;
  }
  throw new Error("the model listing did not fail");
}

test.each(["throw", "exit"] as const)("a model listing that fails with the key in its error or stderr (%s) leaks it nowhere, the cause included", async (leak) => {
  const error = await listingError(leak);
  expect(error).toMatchObject({ message: "Failed to list Cursor models" });
  const seen = everything(error);
  expect(seen).toContain("[redacted]");
  expect(seen).not.toContain(KEY);
});

test.each(["throw", "exit"] as const)("a status read that fails with a secret of the call's env (%s) leaks it nowhere", async (leak) => {
  const status = await fakeCursorRuntime("subprocess").authStatus(bundled, { env: { OAR_FAKE_LEAK_SECRET: SECRET, OAR_FAKE_LEAK: leak } });
  expect(status).toMatchObject({ kind: "unknown" });
  const seen = everything(status);
  expect(seen).toContain("[redacted]");
  expect(seen).not.toContain(SECRET);
});

// Native Node validation quotes an escaped NUL, which no longer matches the
// literal environment value. Guard the spawn before the SDK can be loaded.
test.each(["session", "models", "status"] as const)("Cursor subprocess %s rejects NUL env without leaking its escaped value", async (operation) => {
  const runtime = fakeCursorRuntime("subprocess", "clean");
  const env = { OAR_TEST_SECRET: `${SECRET}\0` };
  const calls = {
    session: async () => runtime.session(bundled, { cwd: process.cwd(), env }),
    models: async () => runtime.listModels(bundled, { env }),
    status: async () => runtime.authStatus(bundled, { env }),
  };
  const result: unknown = await calls[operation]().catch((error: unknown) => error);
  expect(everything(result)).not.toContain(SECRET);
  if (operation === "status") { expect(result).toMatchObject({ kind: "unknown" }); }
  else { expect(result).toBeInstanceOf(Error); }
  expect(everything(result)).toContain("without null bytes");
});

test.each(["throw", "exit"] as const)("inherited CURSOR_API_KEY in subprocess inherit mode is redacted in model listing and session open errors (%s)", async (leak) => {
  vi.stubEnv("CURSOR_API_KEY", KEY);
  const runtime = fakeCursorRuntime("subprocess", "inherit");
  const modelError: unknown = await runtime.listModels(bundled, { env: { OAR_FAKE_LEAK: leak } }).catch((error: unknown) => error);
  expect(everything(modelError)).toContain("[redacted]");
  expect(everything(modelError)).not.toContain(KEY);
  const session = await runtime.session(bundled, { cwd: process.cwd(), env: { OAR_FAKE_LEAK: leak } }).catch((error: unknown) => error);
  expect(everything(session)).not.toContain(KEY);
});

const MCP_HEAD = "McpHeadHalf";
const MCP_TAIL = "McpTailHalf42";
const MCP_SECRET = `${MCP_HEAD}__${MCP_TAIL}`;

const mcpCases: readonly { readonly label: string; readonly server: McpServer }[] = [
  { label: "http", server: { name: "remote", type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: `Bearer ${MCP_SECRET}` } } },
  { label: "stdio", server: { name: "local", command: "node", args: ["echo.mjs"], env: { MCP_SECRET } } },
];

function expectMcpSecretRedacted(seen: string): void {
  expect(seen).toContain("[redacted]");
  expect(seen).not.toContain(MCP_SECRET);
  expect(seen).not.toContain(MCP_HEAD);
  expect(seen).not.toContain(MCP_TAIL);
}

test.each(mcpCases)("subprocess open failure redacts $label mcpServers credential in stderr before -1000 truncation", async ({ server }) => {
  const runtime = fakeCursorRuntime("subprocess", "clean");
  const failure: unknown = await runtime.session(bundled, {
    cwd: process.cwd(),
    env: { OAR_FAKE_MCP_LEAK: "open-exit" },
    mcpServers: [server],
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expectMcpSecretRedacted(everything(failure));
});

test.each(mcpCases)("subprocess child crash redacts $label mcpServers credential in stderr before -1000 truncation", async ({ server }) => {
  const session = await fakeCursorRuntime("subprocess", "clean").session(bundled, { cwd: process.cwd(), mcpServers: [server] });
  try {
    await session.prompt("crash-mcp-stderr");
    await until(() => responsesOf(session, "exited").length > 0);
    expect(responsesOf(session, "exited").length).toBeGreaterThan(0);
    expectMcpSecretRedacted(everything(session.records()));
  } finally {
    await session.dispose();
  }
});
