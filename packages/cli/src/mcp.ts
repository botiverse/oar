import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Subagents } from "@botiverse/oar/agents";
import { ToolInputError, type McpTool } from "./mcp-tools.js";

/**
 * A minimal MCP server over stdio (newline-delimited JSON-RPC): initialize,
 * ping, tools/list and tools/call. Every tool result also says which
 * subagents finished with reports nobody has read, since an MCP server can
 * only speak when the client calls it.
 */

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = [
  "Delegate tasks to subagents running on other agent runtimes (claude, codex, grok, kimi, cursor, antigravity, pi).",
  "run starts one and waits until its turn ends. For parallel work, spawn several and collect them with wait.",
  "A subagent sees nothing of this conversation: put everything it needs in the task.",
  "Continue one with send, or later with run and resume set to its sessionId.",
].join(" ");

export interface McpServerOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly tools: readonly McpTool[];
  readonly crew: Subagents;
  readonly version: string;
}

type JsonRpcId = string | number;

interface JsonRpcRequest {
  readonly id?: JsonRpcId;
  readonly method?: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

function parse(line: string): JsonRpcRequest | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function unreadNote(crew: Subagents): string {
  const unread = crew.unread();
  if (unread.length === 0) {
    return "";
  }
  const names = unread.map((report) => `${report.id} (turn ${String(report.turn)})`).join(", ");
  return `\n\nFinished with unread reports: ${names}. Call wait to read them.`;
}

async function callTool(options: McpServerOptions, params: Readonly<Record<string, unknown>>): Promise<unknown> {
  const tool = options.tools.find((candidate) => candidate.name === params.name);
  if (tool === undefined) {
    return { content: [{ type: "text", text: `unknown tool ${String(params.name)}` }], isError: true };
  }
  const args = typeof params.arguments === "object" && params.arguments !== null && !Array.isArray(params.arguments)
    ? Object.fromEntries(Object.entries(params.arguments))
    : {};
  try {
    const result = await tool.call(args);
    const refused = typeof result === "object" && result !== null && "kind" in result && (result.kind === "refused" || result.kind === "rejected");
    const note = tool.name === "wait" || tool.name === "run" ? "" : unreadNote(options.crew);
    return { content: [{ type: "text", text: `${JSON.stringify(result, null, 2)}${note}` }], ...(refused ? { isError: true } : {}) };
  } catch (error) {
    if (error instanceof ToolInputError) {
      return { content: [{ type: "text", text: error.message }], isError: true };
    }
    throw error;
  }
}

async function answer(options: McpServerOptions, request: JsonRpcRequest): Promise<unknown> {
  const params = request.params ?? {};
  switch (request.method ?? "") {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "oar", version: options.version },
        instructions: INSTRUCTIONS,
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: options.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    case "tools/call": {
      const result = await callTool(options, params);
      return result;
    }
    default:
      throw new RangeError(`method not found: ${String(request.method)}`);
  }
}

/** Serve until the input ends (the client went away), then close every subagent. */
export async function serveMcp(options: McpServerOptions): Promise<void> {
  const write = (message: unknown): void => {
    options.output.write(`${JSON.stringify(message)}\n`);
  };
  const lines = createInterface({ input: options.input, crlfDelay: Infinity });
  for await (const line of lines) {
    const request = parse(line);
    if (request?.id === undefined) {
      continue; // Notifications (initialized, cancelled) need no answer.
    }
    const { id } = request;
    // Calls run concurrently: a long `run` must not hold a `list` behind it.
    void (async (): Promise<void> => {
      try {
        write({ jsonrpc: "2.0", id, result: await answer(options, request) });
      } catch (error) {
        const notFound = error instanceof RangeError;
        write({ jsonrpc: "2.0", id, error: { code: notFound ? -32_601 : -32_603, message: error instanceof Error ? error.message : String(error) } });
      }
    })();
  }
  await options.crew.close();
}
