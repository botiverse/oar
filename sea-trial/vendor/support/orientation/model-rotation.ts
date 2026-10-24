import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { ORIGINAL } from "../user-configuration/model.js";
import { TOKEN } from "../user-configuration/claude-oauth.js";

/** Hold an old-token request while another process refreshes, then reject it. */
export async function rotatingModelProxy(upstreamUrl: string): Promise<{
  readonly url: string;
  readonly auth: { original: boolean; rotated: boolean }[];
  waitForOldToken(): Promise<void>;
  release(): void;
  close(): Promise<void>;
}> {
  const first = Promise.withResolvers<void>(), refreshed = Promise.withResolvers<void>();
  const auth: { original: boolean; rotated: boolean }[] = [];
  const proxy = createServer((request, response) => {
    void (async (): Promise<void> => {
      try {
        if (request.url?.startsWith("/v1/messages") === true && !request.url.includes("count_tokens")) {
          const original = request.headers.authorization === `Bearer ${ORIGINAL}`;
          auth.push({ original, rotated: request.headers.authorization === `Bearer ${TOKEN}` });
          if (original) {
            first.resolve();
            await refreshed.promise;
            response.writeHead(401, { "content-type": "application/json" });
            response.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "Synthetic access token rotated by another process" } }));
            return;
          }
        }
        const upstream = httpRequest(new URL(request.url ?? "/", upstreamUrl), { method: request.method, headers: request.headers }, (reply) => {
          response.writeHead(reply.statusCode ?? 500, reply.headers);
          reply.pipe(response);
        });
        upstream.on("error", () => { response.writeHead(502); response.end(); });
        request.pipe(upstream);
      } catch { response.writeHead(500); response.end(); }
    })();
  });
  const listening = Promise.withResolvers<void>();
  proxy.once("error", listening.reject);
  proxy.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = proxy.address();
  assert.ok(address !== null && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${String(address.port)}`, auth,
    async waitForOldToken(): Promise<void> {
      const timer = setTimeout(() => { first.reject(new Error("No old-token request within 15 seconds")); }, 15_000);
      try { await first.promise; } finally { clearTimeout(timer); }
    },
    release(): void { refreshed.resolve(); },
    async close(): Promise<void> {
      refreshed.resolve();
      proxy.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      proxy.close(() => { closed.resolve(); });
      await closed.promise;
    },
  };
}
