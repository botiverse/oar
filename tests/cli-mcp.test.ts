import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { serveMcp } from "../packages/cli/src/mcp.js";
import { subagentTools } from "../packages/cli/src/mcp-tools.js";
import { createSubagents } from "../packages/oar/src/agents/index.js";
import { scriptedRuntime } from "../packages/oar/src/testing/index.js";
import { echo, Gate, type Script } from "./fixtures/subagent-fixtures.js";

type Crew = Parameters<typeof serveMcp>[0]["crew"];

interface Client {
  readonly request: (method: string, params?: Record<string, unknown>) => { readonly id: number; readonly answer: Promise<Record<string, unknown>> };
  readonly notify: (method: string, params?: Record<string, unknown>) => void;
  readonly call: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  readonly tool: (name: string, args?: Record<string, unknown>) => Promise<{ readonly text: string; readonly isError: boolean }>;
  readonly end: () => Promise<void>;
}

function startServer(script: Script): { readonly input: PassThrough; readonly output: PassThrough; readonly served: Promise<void> } {
  const runtime = scriptedRuntime({ id: "fake", turn: script });
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

function connect(script: Script = echo): Client {
  const { input, output, served } = startServer(script);
  const answers = new Map<number, (message: Record<string, unknown>) => void>();
  createInterface({ input: output }).on("line", (line) => {
    const message: unknown = JSON.parse(line);
    if (typeof message === "object" && message !== null && "id" in message && typeof message.id === "number") {
      answers.get(message.id)?.(Object.fromEntries(Object.entries(message)));
    }
  });
  let next = 0;
  const request = (method: string, params: Record<string, unknown> = {}): { readonly id: number; readonly answer: Promise<Record<string, unknown>> } => {
    next += 1;
    const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
    answers.set(next, resolve);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: next, method, params })}\n`);
    return { id: next, answer: promise };
  };
  const notify = (method: string, params: Record<string, unknown> = {}): void => {
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  };
  const call = async (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const answer = await request(method, params).answer;
    return answer;
  };
  const tool = async (name: string, args: Record<string, unknown> = {}): Promise<{ readonly text: string; readonly isError: boolean }> => {
    const answer = await call("tools/call", { name, arguments: args });
    return textOf(answer);
  };
  return { request, notify, call, tool, end: async () => {
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

test("MCP run forwards serviceTier through the crew to the native session", async () => {
  const observed: (string | undefined)[] = [];
  const client = connect((turn) => { observed.push(turn.options.serviceTier); turn.say("done"); });
  const answer = await client.tool("run", { runtime: "fake", task: "hello", serviceTier: "priority" });
  expect(answer.isError).toBe(false);
  expect(observed).toEqual(["priority"]);
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

async function answeredWithin(answer: Promise<unknown>, ms: number): Promise<boolean> {
  const answered = (async (): Promise<boolean> => {
    await answer;
    return true;
  })();
  const result = await Promise.race([answered, delay(ms, false)]);
  return result;
}

test("a cancelled run gets no answer and leaves its report for wait", async () => {
  const gate = new Gate();
  const client = connect(gate.script);
  const run = client.request("tools/call", { name: "run", arguments: { runtime: "fake", task: "slow", name: "slow" } });
  await expect.poll(() => gate.started, { timeout: 5000 }).toBe(1);
  client.notify("notifications/cancelled", { requestId: run.id });
  gate.release();
  expect(await toolText(client, "wait", { timeoutMs: 5000 })).toContain('"id": "slow"');
  expect(await answeredWithin(run.answer, 100)).toBe(false);
  await client.end();
});

test("the server finishes when its input ends with a run still pending", async () => {
  const gate = new Gate();
  const client = connect(gate.script);
  void client.request("tools/call", { name: "run", arguments: { runtime: "fake", task: "never ends" } });
  await expect.poll(() => gate.started, { timeout: 5000 }).toBe(1);
  await client.end();
});
