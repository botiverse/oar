import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { grokMcpStartup } from "../../packages/oar/src/runtimes/grok/mcp-startup.js";

const server = { name: "host", type: "http", url: "http://127.0.0.1/mcp" } as const;
const second = { name: "extra", type: "http", url: "http://127.0.0.1/extra" } as const;
const open = { cwd: "/work", mcpServers: [{ ...server, origin: "serveMcpTools" }] } as const;
const twoServed = { cwd: "/work", mcpServers: [{ ...server, origin: "serveMcpTools" }, { ...second, origin: "serveMcpTools" }] } as const;
const complete = "_x.ai/mcp_initialized";
const status = "_x.ai/mcp/server_status";

test("only a served entry waits; a handshake alone or another session's completion cannot release it", async () => {
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

test("mcp_initialized alone does not release wait until every served server reports ready", async () => {
  const gate = grokMcpStartup(twoServed);
  assert.ok(gate);
  const stop = new AbortController();
  const pending = gate.wait("mine", stop.signal);
  gate.observe(complete, { sessionId: "mine", mcpToolCount: 1 });
  gate.observe(status, { sessionId: "mine", name: "host", status: "initializing" });
  gate.observe(status, { sessionId: "mine", name: "host", status: "ready" });
  gate.observe(status, { sessionId: "mine", name: "extra", status: "ready" });
  await pending;
});

test("matching completion and ready status before the native open reply are retained", async () => {
  const gate = grokMcpStartup(open);
  assert.ok(gate);
  gate.observe(status, { sessionId: "other", name: "host", status: "unavailable", reason: "foreign" });
  gate.observe(complete, { sessionId: "mine", mcpToolCount: 0 });
  gate.observe(status, { sessionId: "mine", name: "host", status: "ready", reason: "initialized" });
  await gate.wait("mine", new AbortController().signal);
});

test("unavailable after mcp_initialized rejects with Grok's native reason", async () => {
  const gate = grokMcpStartup(open);
  assert.ok(gate);
  const pending = gate.wait("mine", new AbortController().signal);
  gate.observe(complete, { sessionId: "mine", mcpToolCount: 0 });
  gate.observe(status, { sessionId: "mine", name: "host", status: "unavailable", reason: "handshake_failed" });
  await expect(pending).rejects.toThrow('Grok served MCP server "host": handshake_failed');
});

test("unavailable before mcp_initialized rejects immediately", async () => {
  const before = grokMcpStartup(open);
  assert.ok(before);
  const first = before.wait("mine", new AbortController().signal);
  before.observe(status, { sessionId: "mine", name: "host", status: "unavailable", reason: "handshake_failed" });
  await expect(first).rejects.toThrow('Grok served MCP server "host": handshake_failed');
});

test("other non-ready terminal statuses reject using status as fallback reason", async () => {
  const auth = grokMcpStartup(open);
  assert.ok(auth);
  const secondWait = auth.wait("mine", new AbortController().signal);
  auth.observe(complete, { sessionId: "mine", mcpToolCount: 0 });
  auth.observe(status, { sessionId: "mine", name: "host", status: "needsauth" });
  await expect(secondWait).rejects.toThrow('Grok served MCP server "host": needsauth');
});

const requiredStdio = { name: "local", command: "node", args: ["server.js"], required: true } as const;

test("required stdio and http entries wait for ready status", async () => {
  const gate = grokMcpStartup({ cwd: "/work", mcpServers: [requiredStdio, { ...second, required: true }] });
  assert.ok(gate);
  const pending = gate.wait("mine", new AbortController().signal);
  gate.observe(complete, { sessionId: "mine", mcpToolCount: 2 });
  gate.observe(status, { sessionId: "mine", name: "local", status: "ready" });
  gate.observe(status, { sessionId: "mine", name: "extra", status: "ready" });
  await pending;
});

test("required stdio entry rejects immediately on failure", async () => {
  const failing = grokMcpStartup({ cwd: "/work", mcpServers: [requiredStdio] });
  assert.ok(failing);
  const failed = failing.wait("mine", new AbortController().signal);
  failing.observe(status, { sessionId: "mine", name: "local", status: "unavailable", reason: "spawn_failed" });
  await expect(failed).rejects.toThrow('Grok served MCP server "local": spawn_failed');
});
