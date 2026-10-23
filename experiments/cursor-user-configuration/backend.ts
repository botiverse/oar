import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export const KEY = "crsr_mock_configuration_key_not_a_secret";
const ACCESS = "configuration-fake-access-token";

interface Observation { readonly path: string; readonly storedKey: boolean; readonly accessToken: boolean }

/** Local auth exchange and MCP catalog. The inference endpoint deliberately rejects. */
export async function configurationBackend(): Promise<{
  readonly url: string;
  readonly port: number;
  readonly seen: Observation[];
  close(): Promise<void>;
}> {
  const seen: Observation[] = [];
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); }
    seen.push({ path: request.url ?? "", storedKey: request.headers.authorization === `Bearer ${KEY}`, accessToken: request.headers.authorization === `Bearer ${ACCESS}` });
    if (request.url === "/auth/exchange_user_api_key") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ accessToken: ACCESS }));
    } else if (request.url === "/user-mcp") {
      mcp(Buffer.concat(chunks), response);
    } else if (request.url?.includes("/Run") === true) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "invalid_argument", message: "local configuration probe stops before inference" }));
    } else {
      response.writeHead(200, { "content-type": "application/proto" });
      response.end();
    }
  }
  const server = createServer((request, response) => {
    void (async (): Promise<void> => {
      try { await handle(request, response); }
      catch { response.writeHead(500); response.end(); }
    })();
  });
  const ready = Promise.withResolvers<void>();
  server.once("error", ready.reject);
  server.listen(0, "127.0.0.1", ready.resolve);
  await ready.promise;
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${String(address.port)}`, port: address.port, seen,
    async close(): Promise<void> {
      const closed = Promise.withResolvers<void>();
      server.close(() => { closed.resolve(); });
      server.closeAllConnections();
      await closed.promise;
    },
  };
}

function mcp(body: Buffer, response: ServerResponse): void {
  const request: unknown = JSON.parse(body.toString("utf8"));
  assert.ok(typeof request === "object" && request !== null);
  if (!("id" in request)) { response.writeHead(202); response.end(); return; }
  const method = "method" in request ? request.method : undefined;
  const result = method === "initialize"
    ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "user-config", version: "1.0.0" } }
    : { tools: [{ name: "user_config_probe", description: "user configuration sentinel", inputSchema: { type: "object", properties: {} } }] };
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
}
