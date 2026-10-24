import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { LLMock } from "@copilotkit/aimock";
import { TOKEN } from "./claude-oauth.js";

export const ORIGINAL = "oar-config-probe-original-access-not-a-secret";

/** Observe synthetic authorization before aimock redacts headers from its journal. */
export async function configurationModel(): Promise<{
  readonly url: string;
  readonly requests: unknown[];
  readonly auth: { readonly original: boolean; readonly rotated: boolean }[];
  close(): Promise<void>;
}> {
  const mock = new LLMock({ port: 0 });
  const requests: unknown[] = [];
  const auth: { original: boolean; rotated: boolean }[] = [];
  mock.onMessage(/[\s\S]*/u, (request) => { requests.push(request); return { content: "ok" }; });
  await mock.start();
  const proxy = createServer((request, response) => {
    if (request.url?.startsWith("/v1/messages") === true && !request.url.includes("count_tokens")) {
      auth.push({ original: request.headers.authorization === `Bearer ${ORIGINAL}`, rotated: request.headers.authorization === `Bearer ${TOKEN}` });
    }
    const upstream = httpRequest(new URL(request.url ?? "/", mock.url), { method: request.method, headers: request.headers }, (reply) => {
      response.writeHead(reply.statusCode ?? 500, reply.headers);
      reply.pipe(response);
    });
    upstream.on("error", () => { response.writeHead(502); response.end(); });
    request.pipe(upstream);
  });
  const listening = Promise.withResolvers<void>();
  proxy.once("error", listening.reject);
  proxy.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = proxy.address();
  assert.ok(address !== null && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${String(address.port)}`, requests, auth,
    async close() {
      const closed = Promise.withResolvers<void>();
      proxy.close(() => { closed.resolve(); });
      proxy.closeAllConnections();
      await closed.promise;
      await mock.stop();
    },
  };
}
