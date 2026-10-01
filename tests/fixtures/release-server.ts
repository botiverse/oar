import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";

/** A local stand-in for runtime release sources: each path answers a fixed status and body. */
export interface ReleaseServer {
  readonly base: string;
  readonly routes: Map<string, readonly [number, string]>;
  readonly close: () => void;
}

export async function startReleaseServer(): Promise<ReleaseServer> {
  const routes = new Map<string, readonly [number, string]>();
  const server = createServer((request, response) => {
    const [status, body] = routes.get(request.url ?? "") ?? [404, "not found"];
    response.writeHead(status).end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return { base: `http://127.0.0.1:${String(address.port)}`, routes, close: () => {
    server.close();
  } };
}
