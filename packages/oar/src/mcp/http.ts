import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { asRecord, type JsonRecord } from "../shared/json.js";

/* The HTTP side of serve-tools.ts: authorization, origin, bodies and replies. */

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export function authorized(request: IncomingMessage, expected: Buffer): boolean {
  const given = Buffer.from(request.headers.authorization ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** No Origin (a runtime's MCP client), or a loopback page's: MCP asks servers to refuse other origins (DNS rebinding). */
export function localOrigin(request: IncomingMessage): boolean {
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
export async function body(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size <= MAX_BODY_BYTES) { chunks.push(buffer); }
  }
  return size > MAX_BODY_BYTES ? null : Buffer.concat(chunks).toString("utf8");
}

/** A GET asking for the SSE stream (streamable HTTP: `Accept` names text/event-stream). */
export function acceptsEventStream(request: IncomingMessage): boolean {
  return (request.headers.accept ?? "").includes("text/event-stream");
}

/** How often an open stream gets a comment, so a client's idle timeout never closes it (pi's undici: 300 s). */
const KEEP_ALIVE_MS = 15_000;

/** The open server-to-client SSE streams: one per client GET, held until the client goes away. */
export class EventStreams {
  readonly #open = new Set<ServerResponse>();
  #keepAlive: ReturnType<typeof setInterval> | undefined;

  open(response: ServerResponse, session: string | undefined): void {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", ...(session === undefined ? {} : { "mcp-session-id": session }) });
    response.flushHeaders();
    this.#open.add(response);
    this.#keepAlive ??= setInterval(() => { this.#write(": keep-alive\n\n"); }, KEEP_ALIVE_MS).unref();
    // A client gone mid-write is a closed stream, not a host crash.
    response.on("error", () => { this.#forget(response); });
    response.once("close", () => { this.#forget(response); });
  }

  /** One JSON-RPC message to every open stream. */
  message(message: JsonRecord): void {
    this.#write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  }

  /** End every stream at once: nothing is written to them afterwards, even before their close events. */
  endAll(): void {
    for (const stream of this.#open) {
      this.#forget(stream);
      stream.end();
    }
  }

  #write(chunk: string): void {
    for (const stream of this.#open) {
      if (!stream.writableEnded) { stream.write(chunk); }
    }
  }

  #forget(stream: ServerResponse): void {
    this.#open.delete(stream);
    if (this.#open.size === 0 && this.#keepAlive !== undefined) {
      clearInterval(this.#keepAlive);
      this.#keepAlive = undefined;
    }
  }
}

export function rpcError(response: ServerResponse, code: number, message: string): void {
  response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }));
}

/** The request's messages: one, or a batch (2025-03-26). */
export function messagesOf(parsed: unknown): JsonRecord[] | null {
  const list: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const messages: JsonRecord[] = [];
  for (const entry of list) {
    const message = asRecord(entry);
    if (message === null) { return null; }
    messages.push(message);
  }
  return messages.length > 0 ? messages : null;
}

export async function listen(server: Server): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address: string | AddressInfo | null = server.address();
    if (address !== null && typeof address === "object") { resolve(address.port); } else { reject(new Error("serveMcpTools: no TCP port")); }
  });
  const port = await promise;
  return port;
}
