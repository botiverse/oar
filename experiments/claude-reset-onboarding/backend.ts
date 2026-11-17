/** Synthetic HTTPS proxy: answers locally, never forwards a request. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Socket } from "node:net";

export async function startBackend(key: Buffer, cert: Buffer): Promise<{ url: string; routes: string[]; close(): Promise<void> }> {
  const routes: string[] = [];
  const secure = createHttpsServer({ key, cert }, (request, response) => {
    const url = new URL(request.url ?? "/", "https://api.anthropic.com");
    routes.push(`${request.method ?? "GET"} ${url.pathname}`);
    request.resume();
    let body: unknown = {};
    if (url.pathname === "/api/oauth/profile") {
      body = {
        account: { uuid: "00000000-0000-4000-8000-000000000001", email: "probe@example.invalid", display_name: "Synthetic probe" },
        organization: { uuid: "00000000-0000-4000-8000-000000000002", organization_type: "claude_pro", rate_limit_tier: "default_claude_pro", cc_onboarding_flags: {} },
      };
    } else if (url.pathname === "/v1/messages") {
      body = { id: "synthetic", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  const sockets = new Set<Socket>();
  const proxy = createServer((_request, response) => { response.writeHead(200); response.end("{}"); });
  proxy.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => { sockets.delete(socket); }); });
  proxy.on("connect", (_request, socket, head) => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) { socket.unshift(head); }
    secure.emit("connection", socket);
  });
  const listening = Promise.withResolvers<void>();
  proxy.once("error", listening.reject);
  proxy.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = proxy.address();
  assert.ok(address !== null && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${String(address.port)}`, routes,
    async close(): Promise<void> {
      for (const socket of sockets) { socket.destroy(); }
      const closed = Promise.withResolvers<void>();
      proxy.close(() => { closed.resolve(); });
      await closed.promise;
      secure.close();
    },
  };
}
