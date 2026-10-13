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
