import { once } from "node:events";
import { afterEach, expect, test } from "vitest";
import { serveMcpTools, type HostTool, type ServedMcpTools } from "../packages/oar/src/index.js";

const served: ServedMcpTools[] = [];
afterEach(async () => {
  await Promise.all(served.splice(0).map(async (entry) => { await entry.close(); }));
});

async function serve(tools: readonly HostTool[]): Promise<ServedMcpTools> {
  const entry = await serveMcpTools({ name: "host", tools });
  served.push(entry);
  return entry;
}

async function post(entry: ServedMcpTools, message: object, headers: Record<string, string> = entry.server.headers ?? {}): Promise<Response> {
  const response = await fetch(entry.server.url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(message) });
  return response;
}

async function statusOf(response: Promise<Response>): Promise<number> {
  const { status } = await response;
  return status;
}

async function rpc(entry: ServedMcpTools, method: string, params: object = {}): Promise<unknown> {
  const response = await post(entry, { jsonrpc: "2.0", id: 1, method, params });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  return body;
}

const echo: HostTool = {
  name: "echo",
  description: "Echo text",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  handler: (input) => `echo:${String(input.text)}`,
};

test("the entry is an http server on 127.0.0.1 behind a bearer token", async () => {
  const entry = await serve([echo]);
  expect(entry.server).toMatchObject({ name: "host", type: "http" });
  expect(entry.server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u);
  expect(entry.server.headers?.Authorization).toMatch(/^Bearer [\w-]{40,}$/u);
  expect(await statusOf(post(entry, { jsonrpc: "2.0", id: 1, method: "ping" }, {}))).toBe(401);
  expect(await statusOf(post(entry, { jsonrpc: "2.0", id: 1, method: "ping" }, { Authorization: "Bearer wrong" }))).toBe(401);
  expect(await statusOf(fetch(entry.server.url, { headers: entry.server.headers ?? {} }))).toBe(405);
});

test("initialize, tools/list and tools/call speak MCP", async () => {
  const entry = await serve([echo, { name: "bare", inputSchema: { type: "object" }, handler: () => ({ content: [{ type: "text", text: "no" }], isError: true }) }]);
  expect(await rpc(entry, "initialize", { protocolVersion: "2025-03-26" })).toMatchObject({ result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "host" } } });
  expect(await rpc(entry, "tools/list")).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [
    { name: "echo", description: "Echo text", inputSchema: echo.inputSchema },
    { name: "bare", inputSchema: { type: "object" } },
  ] } });
  expect(await rpc(entry, "tools/call", { name: "echo", arguments: { text: "hi" } })).toEqual({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "echo:hi" }] } });
  expect(await rpc(entry, "tools/call", { name: "bare", arguments: {} })).toMatchObject({ result: { content: [{ type: "text", text: "no" }], isError: true } });
  expect(await rpc(entry, "tools/call", { name: "missing", arguments: {} })).toMatchObject({ error: { code: -32_602 } });
  expect(await rpc(entry, "resources/list")).toMatchObject({ error: { code: -32_601 } });
  expect(await statusOf(post(entry, { jsonrpc: "2.0", method: "notifications/initialized" }))).toBe(202);
});

test("a handler's error is a tool error the model sees, not a protocol error", async () => {
  const entry = await serve([{ name: "boom", inputSchema: { type: "object" }, handler: () => { throw new Error("disk full"); } }]);
  expect(await rpc(entry, "tools/call", { name: "boom", arguments: {} })).toEqual({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "disk full" }], isError: true } });
});

test("a cancelled call aborts the handler's signal", async () => {
  const { promise: started, resolve: begin } = Promise.withResolvers<AbortSignal>();
  const entry = await serve([{ name: "slow", inputSchema: { type: "object" }, handler: async (_input, { signal }) => {
    begin(signal);
    await once(signal, "abort");
    return "stopped";
  } }]);
  const call = post(entry, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "slow", arguments: {} } });
  const signal = await started;
  expect(await statusOf(post(entry, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } }))).toBe(202);
  expect(signal.aborted).toBe(true);
  const answered = await call;
  expect(await answered.json()).toMatchObject({ id: 7, result: { content: [{ type: "text", text: "stopped" }] } });
});

test("close() aborts calls still running and stops listening", async () => {
  const { promise: started, resolve: begin } = Promise.withResolvers<AbortSignal>();
  const entry = await serveMcpTools({ name: "host", tools: [{ name: "hang", inputSchema: { type: "object" }, handler: async (_input, { signal }) => {
    begin(signal);
    await once(signal, "abort");
    return "closed";
  } }] });
  // The connection is cut by close(): the call settles either way.
  const settle = async (): Promise<unknown> => {
    try {
      return await post(entry, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hang", arguments: {} } });
    } catch (error) {
      return error;
    }
  };
  const call = settle();
  const signal = await started;
  await entry.close();
  expect(signal.aborted).toBe(true);
  await call;
  await expect(fetch(entry.server.url, { method: "POST" })).rejects.toThrow();
});

test("bad JSON is a 400, and names runtimes cannot take are refused up front", async () => {
  const entry = await serve([echo]);
  expect(await statusOf(fetch(entry.server.url, { method: "POST", headers: entry.server.headers ?? {}, body: "{" }))).toBe(400);
  await expect(serveMcpTools({ name: "has space", tools: [] })).rejects.toThrow("serveMcpTools name");
  await expect(serveMcpTools({ name: "host", tools: [{ ...echo, name: "a.b" }] })).rejects.toThrow("tool name");
  await expect(serveMcpTools({ name: "host", tools: [echo, echo] })).rejects.toThrow("be unique");
});
