import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { McpServer } from "../contracts/session-options.js";
import { asRecord, parseJson, type JsonRecord } from "../shared/json.js";
import { RESERVED_MCP_SERVER_NAMES } from "../shared/mcp-servers.js";
import { acceptsEventStream, authorized, body, EventStreams, listen, localOrigin, messagesOf, rpcError } from "./http.js";

/*
 * Tools the host implements, served to any runtime that takes
 * `SessionOptions.mcpServers` (#341): an MCP server inside the host process,
 * on 127.0.0.1, behind a bearer token only this host knows. Each runtime
 * attaches it through its own MCP channel, so one implementation reaches
 * them all; no runtime-specific tool channel is involved.
 *
 * The protocol subset is the one every runtime's MCP client was shown to use
 * with tests/fixtures/echo-mcp-server.mjs: streamable HTTP POSTs answered with
 * JSON, notifications answered 202. Each `initialize` opens its own MCP
 * session, so several sessions can share one served set without their request
 * ids meeting. A client's GET opens the one server-to-client channel, an SSE
 * stream that carries only `notifications/tools/list_changed` (#399) and a
 * keep-alive comment.
 */

/** Content a host tool returns, in MCP's own shapes. */
export type HostToolContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

/** A tool's answer: plain text, or MCP content with `isError` for a failed call the model should see. */
export type HostToolResult = string | { readonly content: readonly HostToolContent[]; readonly isError?: boolean };

export interface HostTool {
  /** The tool name the model sees (`^[\w-]{1,64}$`); runtimes may prefix it with the server name. */
  readonly name: string;
  readonly description?: string;
  /** JSON Schema of the input, an object schema, given to the runtime unchanged. OAR does not validate calls against it. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /**
   * Runs one call. `signal` aborts when the runtime cancels the call, drops
   * the request, or the server closes. A thrown error becomes an `isError`
   * result carrying the error's message.
   */
  readonly handler: (input: Readonly<Record<string, unknown>>, context: { readonly signal: AbortSignal }) => HostToolResult | Promise<HostToolResult>;
}

export interface ServeMcpToolsOptions {
  /** The server name runtimes show and prefix tools with (`^[\w-]+$`, the strictest runtime's rule; not one of the names some runtimes drop, #395). */
  readonly name: string;
  readonly tools: readonly HostTool[];
  /**
   * Guidance across the tools (what the group is for, how they work
   * together), returned as the MCP `initialize` result's `instructions`.
   * Whether the model sees it is the runtime's own choice: see
   * docs/spec/runtime-matrix.md#host-served-tools.
   */
  readonly instructions?: string;
}

export interface ServedMcpTools {
  /** The `SessionOptions.mcpServers` entry: http on 127.0.0.1 with the bearer token in `headers`. */
  readonly server: Extract<McpServer, { readonly type: "http" }>;
  /**
   * Replace the served tools, under the same name rules, and send
   * `notifications/tools/list_changed` on every open stream. Calls already
   * running finish with the tool they started with; a call to a tool no
   * longer served is an unknown tool. Whether a running session's model sees
   * the new set is the runtime's choice (#399,
   * docs/spec/runtime-matrix.md#host-served-tools).
   */
  setTools(tools: readonly HostTool[]): void;
  /** Stops serving and aborts calls still running. */
  close(): Promise<void>;
}

const SERVER_NAME = /^[\w-]+$/u;
const TOOL_NAME = /^[\w-]{1,64}$/u;
type CallId = string | number;

function checkName(name: string): void {
  if (!SERVER_NAME.test(name) || RESERVED_MCP_SERVER_NAMES.has(name)) {
    throw new Error(`serveMcpTools name ${JSON.stringify(name)} must match ${String(SERVER_NAME)} and not be one of ${JSON.stringify([...RESERVED_MCP_SERVER_NAMES])}`);
  }
}

function checkTools(given: readonly HostTool[]): ReadonlyMap<string, HostTool> {
  const tools = new Map<string, HostTool>();
  for (const tool of given) {
    if (!TOOL_NAME.test(tool.name) || tools.has(tool.name)) {
      throw new Error(`serveMcpTools tool name ${JSON.stringify(tool.name)} must match ${String(TOOL_NAME)} and be unique`);
    }
    tools.set(tool.name, tool);
  }
  return tools;
}

function listed(tool: HostTool): JsonRecord {
  const entry: JsonRecord = { name: tool.name, inputSchema: tool.inputSchema };
  if (tool.description !== undefined) { entry.description = tool.description; }
  return entry;
}

function toolResult(result: HostToolResult): JsonRecord {
  if (typeof result === "string") {
    return { content: [{ type: "text", text: result }] };
  }
  return { content: [...result.content], ...(result.isError === true ? { isError: true } : {}) };
}

/** The protocol versions this server speaks; a client asking for another gets the latest. */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

/** Where one HTTP request's messages come from: the client's MCP session, and a signal for the request going away. */
interface Origin {
  readonly session: string;
  readonly dropped: AbortSignal;
}

class ToolServer {
  readonly #name: string;
  readonly #instructions: string | undefined;
  #tools: ReadonlyMap<string, HostTool>;
  /** Running calls by MCP session and request id: clients number requests alike, so an id alone is not one call. */
  readonly #calls = new Map<string, AbortController>();
  /** Open server-to-client SSE streams (a client's GET). */
  readonly streams = new EventStreams();

  constructor(options: ServeMcpToolsOptions, tools: ReadonlyMap<string, HostTool>) {
    this.#name = options.name;
    this.#instructions = options.instructions;
    this.#tools = tools;
  }

  setTools(tools: ReadonlyMap<string, HostTool>): void {
    this.#tools = tools;
    this.streams.message({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  }

  /** The JSON-RPC answer to one message, or null for a notification or a client's response. */
  async answer(message: JsonRecord, origin: Origin): Promise<JsonRecord | null> {
    const { id, method } = message;
    const params = asRecord(message.params) ?? {};
    if (typeof method !== "string") {
      return null;
    }
    if (typeof id !== "string" && typeof id !== "number") {
      const cancelled = params.requestId;
      if (method === "notifications/cancelled" && (typeof cancelled === "string" || typeof cancelled === "number")) { this.#calls.get(callKey(origin.session, cancelled))?.abort(); }
      return null;
    }
    const reply = await this.#result(id, method, params, origin);
    return { jsonrpc: "2.0", id, ...reply };
  }

  abortAll(): void {
    for (const controller of this.#calls.values()) { controller.abort(); }
    this.streams.endAll();
  }

  async #result(id: CallId, method: string, params: JsonRecord, origin: Origin): Promise<JsonRecord> {
    switch (method) {
      case "initialize":
        return { result: {
          protocolVersion: typeof params.protocolVersion === "string" && PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: this.#name, version: "1.0.0" },
          ...(this.#instructions === undefined ? {} : { instructions: this.#instructions }),
        } };
      case "ping":
        return { result: {} };
      case "tools/list":
        return { result: { tools: [...this.#tools.values()].map((tool) => listed(tool)) } };
      case "tools/call": {
        const reply = await this.#call(callKey(origin.session, id), params, origin.dropped);
        return reply;
      }
      default:
        return { error: { code: -32_601, message: `method not found: ${method}` } };
    }
  }

  async #call(key: string, params: JsonRecord, dropped: AbortSignal): Promise<JsonRecord> {
    const tool = typeof params.name === "string" ? this.#tools.get(params.name) : undefined;
    if (tool === undefined) {
      return { error: { code: -32_602, message: `unknown tool: ${String(params.name)}` } };
    }
    const controller = new AbortController();
    const abort = (): void => { controller.abort(); };
    dropped.addEventListener("abort", abort, { once: true });
    this.#calls.set(key, controller);
    try {
      return { result: toolResult(await tool.handler(asRecord(params.arguments) ?? {}, { signal: controller.signal })) };
    } catch (error) {
      return { result: { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true } };
    } finally {
      if (this.#calls.get(key) === controller) { this.#calls.delete(key); }
      dropped.removeEventListener("abort", abort);
    }
  }
}

function callKey(session: string, id: CallId): string {
  return JSON.stringify([session, id]);
}

async function respond(tools: ToolServer, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const text = await body(request);
  if (text === null) {
    response.writeHead(413, { connection: "close" }).end();
    return;
  }
  const parsed = parseJson(text);
  const messages = messagesOf(parsed);
  if (messages === null) {
    rpcError(response, parsed === undefined ? -32_700 : -32_600, parsed === undefined ? "parse error" : "invalid request");
    return;
  }
  // A new MCP session per initialize, so each client's request ids are its own.
  const opened = messages.some((message) => message.method === "initialize") ? `oar-host-tools-${randomBytes(12).toString("hex")}` : undefined;
  const header = request.headers["mcp-session-id"];
  const session = opened ?? (typeof header === "string" ? header : "");
  const dropped = new AbortController();
  response.once("close", () => { if (!response.writableEnded) { dropped.abort(); } });
  const answered = await Promise.all(messages.map(async (message) => {
    const reply = await tools.answer(message, { session, dropped: dropped.signal });
    return reply;
  }));
  const replies = answered.filter((reply) => reply !== null);
  if (replies.length === 0) {
    response.writeHead(202).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json", ...(session === "" ? {} : { "mcp-session-id": session }) }).end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
}

/** One authorized POST, never rejecting: a failure the reply did not cover becomes a 500. */
async function serve(tools: ToolServer, request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    await respond(tools, request, response);
  } catch {
    if (!response.headersSent) { response.writeHead(500).end(); }
  }
}

/**
 * Serve host-implemented tools over MCP for `SessionOptions.mcpServers`.
 * Pass `served.server` in a session's `mcpServers`; one served set can back
 * several sessions. The runtime must reach the host's 127.0.0.1 (it does when
 * OAR starts it on this machine or runs it in this process). Runtimes that
 * refuse an http entry or its `headers` refuse this one too (cursor,
 * pi-durable, antigravity): see docs/spec/runtime-matrix.md#host-served-tools.
 */
export async function serveMcpTools(options: ServeMcpToolsOptions): Promise<ServedMcpTools> {
  checkName(options.name);
  const tools = new ToolServer(options, checkTools(options.tools));
  const token = randomBytes(32).toString("base64url");
  const expected = Buffer.from(`Bearer ${token}`);
  const server = createServer((request, response) => {
    if (!localOrigin(request)) { response.writeHead(403).end(); return; }
    if (!authorized(request, expected)) { response.writeHead(401).end(); return; }
    if (request.method === "GET" && acceptsEventStream(request)) {
      const session = request.headers["mcp-session-id"];
      tools.streams.open(response, typeof session === "string" ? session : undefined);
      return;
    }
    if (request.method !== "POST") { response.writeHead(405, { allow: "GET, POST" }).end(); return; }
    void serve(tools, request, response);
  });
  const port = await listen(server);
  return {
    server: { name: options.name, type: "http", url: `http://127.0.0.1:${String(port)}/mcp`, headers: { Authorization: `Bearer ${token}` } },
    setTools(next) {
      tools.setTools(checkTools(next));
    },
    async close() {
      tools.abortAll();
      const { promise, resolve } = Promise.withResolvers<void>();
      server.close(() => { resolve(); });
      server.closeAllConnections();
      await promise;
    },
  };
}
