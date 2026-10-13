import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "../contracts/session-options.js";
import { asRecord, parseJson, type JsonRecord } from "../shared/json.js";

/*
 * Tools the host implements, served to any runtime that takes
 * `SessionOptions.mcpServers` (#341): an MCP server inside the host process,
 * on 127.0.0.1, behind a bearer token only this host knows. Each runtime
 * attaches it through its own MCP channel, so one implementation reaches
 * them all; no runtime-specific tool channel is involved.
 *
 * The protocol subset is the one every runtime's MCP client was shown to use
 * with tests/fixtures/echo-mcp-server.mjs: streamable HTTP POSTs answered with
 * JSON (no SSE stream: GET is 405), notifications answered 202. Each
 * `initialize` opens its own MCP session, so several sessions can share one
 * served set without their request ids meeting.
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
  /** The server name runtimes show and prefix tools with (`^[\w-]+$`, the strictest runtime's rule). */
  readonly name: string;
  readonly tools: readonly HostTool[];
}

export interface ServedMcpTools {
  /** The `SessionOptions.mcpServers` entry: http on 127.0.0.1 with the bearer token in `headers`. */
  readonly server: Extract<McpServer, { readonly type: "http" }>;
  /** Stops serving and aborts calls still running. */
  close(): Promise<void>;
}

const SERVER_NAME = /^[\w-]+$/u;
const TOOL_NAME = /^[\w-]{1,64}$/u;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
type CallId = string | number;

function checkTools(options: ServeMcpToolsOptions): ReadonlyMap<string, HostTool> {
  if (!SERVER_NAME.test(options.name)) {
    throw new Error(`serveMcpTools name ${JSON.stringify(options.name)} must match ${String(SERVER_NAME)}`);
  }
  const tools = new Map<string, HostTool>();
  for (const tool of options.tools) {
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
  readonly #tools: ReadonlyMap<string, HostTool>;
  /** Running calls by MCP session and request id: clients number requests alike, so an id alone is not one call. */
  readonly #calls = new Map<string, AbortController>();

  constructor(name: string, tools: ReadonlyMap<string, HostTool>) {
    this.#name = name;
    this.#tools = tools;
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
  }

  async #result(id: CallId, method: string, params: JsonRecord, origin: Origin): Promise<JsonRecord> {
    switch (method) {
      case "initialize":
        return { result: {
          protocolVersion: typeof params.protocolVersion === "string" && PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: this.#name, version: "1.0.0" },
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

function authorized(request: IncomingMessage, expected: Buffer): boolean {
  const given = Buffer.from(request.headers.authorization ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** No Origin (a runtime's MCP client), or a loopback page's: MCP asks servers to refuse other origins (DNS rebinding). */
function localOrigin(request: IncomingMessage): boolean {
  const { origin } = request.headers;
  if (origin === undefined) {
    return true;
  }
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** The request body, or null past MAX_BODY_BYTES. The rest is still read: answering before the client finished sending resets its connection (seen on Windows). */
async function body(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size <= MAX_BODY_BYTES) { chunks.push(buffer); }
  }
  return size > MAX_BODY_BYTES ? null : Buffer.concat(chunks).toString("utf8");
}

function rpcError(response: ServerResponse, code: number, message: string): void {
  response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }));
}

/** The request's messages: one, or a batch (2025-03-26). */
function messagesOf(parsed: unknown): JsonRecord[] | null {
  const list: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const messages: JsonRecord[] = [];
  for (const entry of list) {
    const message = asRecord(entry);
    if (message === null) { return null; }
    messages.push(message);
  }
  return messages.length > 0 ? messages : null;
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

async function listen(server: Server): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address: string | AddressInfo | null = server.address();
    if (address !== null && typeof address === "object") { resolve(address.port); } else { reject(new Error("serveMcpTools: no TCP port")); }
  });
  const port = await promise;
  return port;
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
  const tools = new ToolServer(options.name, checkTools(options));
  const token = randomBytes(32).toString("base64url");
  const expected = Buffer.from(`Bearer ${token}`);
  const server = createServer((request, response) => {
    if (!localOrigin(request)) { response.writeHead(403).end(); return; }
    if (!authorized(request, expected)) { response.writeHead(401).end(); return; }
    if (request.method !== "POST") { response.writeHead(405, { allow: "POST" }).end(); return; }
    void serve(tools, request, response);
  });
  const port = await listen(server);
  return {
    server: { name: options.name, type: "http", url: `http://127.0.0.1:${String(port)}/mcp`, headers: { Authorization: `Bearer ${token}` } },
    async close() {
      tools.abortAll();
      const { promise, resolve } = Promise.withResolvers<void>();
      server.close(() => { resolve(); });
      server.closeAllConnections();
      await promise;
    },
  };
}
