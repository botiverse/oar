import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { grokMcpStartup } from "../../packages/oar/src/runtimes/grok/mcp-startup.js";

const server = { name: "host", type: "http", url: "http://127.0.0.1/mcp" } as const;
const open = { cwd: "/work", mcpServers: [{ ...server, origin: "serveMcpTools" }] } as const;
const complete = "_x.ai/mcp_initialized";
const status = "_x.ai/mcp/server_status";

test("only a served entry waits; a handshake and another session's completion cannot release it", async () => {
  expect(grokMcpStartup({ cwd: "/work", mcpServers: [server] })).toBeUndefined();
  const gate = grokMcpStartup(open);
  assert.ok(gate);
  gate.observe(status, { sessionId: "mine", name: "host", status: "ready" });
  gate.observe(complete, { sessionId: "peer" });
  gate.observe(status, { sessionId: "mine", name: "optional", status: "unavailable", reason: "handshake_failed" });
  const stop = new AbortController();
  const pending = gate.wait("mine", stop.signal);
  stop.abort(new Error("open deadline"));
  await expect(pending).rejects.toThrow("open deadline");
});

test("a matching completion before the native open reply is retained", async () => {
  const gate = grokMcpStartup(open);
  assert.ok(gate);
  gate.observe(status, { sessionId: "other", name: "host", status: "unavailable", reason: "foreign" });
  gate.observe(complete, { sessionId: "mine", mcpToolCount: 0 });
  await gate.wait("mine", new AbortController().signal);
});

test("a named failure while opening carries Grok's native reason", async () => {
  const gate = grokMcpStartup(open);
  assert.ok(gate);
  const pending = gate.wait("mine", new AbortController().signal);
  gate.observe(status, { sessionId: "mine", name: "host", status: "unavailable", reason: "handshake_failed" });
  gate.observe(complete, { sessionId: "mine", mcpToolCount: 1 });
  await expect(pending).rejects.toThrow('Grok served MCP server "host": handshake_failed');
});
