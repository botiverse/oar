import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { expect, test } from "vitest";
import { serveMcp } from "../packages/cli/src/mcp.js";
import { subagentTools } from "../packages/cli/src/mcp-tools.js";
import { createSubagents } from "../packages/oar/src/agents/index.js";
import { scriptedRuntime } from "../packages/oar/src/testing/index.js";

type Crew = Parameters<typeof serveMcp>[0]["crew"];

interface Client {
  readonly call: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  readonly tool: (name: string, args?: Record<string, unknown>) => Promise<{ readonly text: string; readonly isError: boolean }>;
  readonly end: () => Promise<void>;
}

function startServer(): { readonly input: PassThrough; readonly output: PassThrough; readonly served: Promise<void> } {
  const runtime = scriptedRuntime({ id: "fake", turn: (turn) => {
    turn.say(`did: ${turn.input}`);
  } });
  const crew: Crew = createSubagents({ runtimes: { get: (id) => (id === "fake" ? runtime : undefined) } });
  const input = new PassThrough();
  const output = new PassThrough();
  const served = serveMcp({ input, output, tools: subagentTools(crew, []), crew, version: "0.0.0-test" });
  return { input, output, served };
}

function textOf(answer: Record<string, unknown>): { readonly text: string; readonly isError: boolean } {
  const { result } = answer;
  const record = typeof result === "object" && result !== null ? Object.fromEntries(Object.entries(result)) : {};
  const content: unknown[] = Array.isArray(record.content) ? record.content : [];
  const [first] = content;
  const text = typeof first === "object" && first !== null && "text" in first && typeof first.text === "string" ? first.text : "";
  return { text, isError: record.isError === true };
}

function connect(): Client {
  const { input, output, served } = startServer();
  const answers = new Map<number, (message: Record<string, unknown>) => void>();
  createInterface({ input: output }).on("line", (line) => {
    const message: unknown = JSON.parse(line);
    if (typeof message === "object" && message !== null && "id" in message && typeof message.id === "number") {
      answers.get(message.id)?.(Object.fromEntries(Object.entries(message)));
    }
  });
  let next = 0;
  const call = async (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    next += 1;
    const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
    answers.set(next, resolve);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: next, method, params })}\n`);
    const answer = await promise;
    return answer;
  };
  const tool = async (name: string, args: Record<string, unknown> = {}): Promise<{ readonly text: string; readonly isError: boolean }> => {
    const answer = await call("tools/call", { name, arguments: args });
    return textOf(answer);
  };
  return { call, tool, end: async () => {
    input.end();
    await served;
  } };
}

async function toolText(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const { text } = await client.tool(name, args);
  return text;
}

test("the server answers initialize with the client's protocol version and lists the subagent tools", async () => {
  const client = connect();
  const initialized = await client.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  expect(initialized.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "oar" } });
  const listed = await client.call("tools/list");
  expect(JSON.stringify(listed.result)).toContain('"name":"run"');
  const missing = await client.call("no/such");
  expect(missing.error).toMatchObject({ code: -32_601 });
  await client.end();
});

test("run waits for the subagent's turn and returns its report", async () => {
  const client = connect();
  const { text, isError } = await client.tool("run", { runtime: "fake", task: "list files" });
  expect(isError).toBe(false);
  expect(text).toContain('"text": "did: list files"');
  expect(text).toContain('"turn": 1');
  await client.end();
});

test("spawned subagents that finished are named in later tool results until wait reads them", async () => {
  const client = connect();
  expect(await toolText(client, "spawn", { runtime: "fake", task: "a", name: "alpha" })).toContain('"id": "alpha"');
  await expect.poll(async () => toolText(client, "list"), { timeout: 5000 }).toContain("Finished with unread reports: alpha (turn 1)");
  expect(await toolText(client, "wait", { timeoutMs: 1000 })).toContain('"text": "did: a"');
  expect(await toolText(client, "list")).not.toContain("Finished with unread reports");
  await client.end();
});

test("refusals and bad input come back as tool errors", async () => {
  const client = connect();
  expect(await client.tool("run", { runtime: "missing", task: "x" })).toMatchObject({ isError: true });
  expect(await client.tool("send", { id: "nobody", message: "hi" })).toMatchObject({ isError: true, text: "no subagent nobody; the list tool names them" });
  expect(await client.tool("spawn", { runtime: "fake" })).toMatchObject({ isError: true, text: "task is required" });
  await client.end();
});
