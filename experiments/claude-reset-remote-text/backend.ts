/** Synthetic HTTPS proxy: answers locally, never forwards a request. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Socket } from "node:net";

export async function startBackend(key: Buffer, cert: Buffer, altered = false): Promise<{ url: string; routes: string[]; close(): Promise<void> }> {
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
    } else if (url.pathname.includes("/api/eval")) {
      body = { features: { tengu_cedar_ember: { defaultValue: { enabled: true, version: 1, ...(altered ? { confirmTitle: "REMOTE CHANGED: spend {kind}?", confirmYes: "REMOTE CHANGED: spend it" } : {}) } } } };
    } else if (url.pathname.endsWith("/usage")) {
      const later = new Date(Date.now() + 86_400_000).toISOString();
      body = {
        five_hour: { utilization: 0, resets_at: later }, seven_day: { utilization: 100, resets_at: later },
        cedar_ember: {
          eligible: true, at_limit: true, exhausted: ["seven_day"], weekly_resets_at: later,
          next_grant_id: "weekly-probe", grants: [{
            id: "weekly-probe", label: "Weekly reset", resets_total: 2, resets_left: 2,
            starts_at: new Date(Date.now() - 3_600_000).toISOString(), ends_at: later,
            clears: ["seven_day"], paused: false, usable_now: true, use_requires_limit: true,
            percent_used: { seven_day: 100 }, blocking: [], type: "weekly", gives_back_weekly: false,
          }],
        },
      };
    } else if (url.pathname === "/v1/messages") {
      body = { id: "synthetic", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  const sockets = new Set<Socket>();
  const proxy = createServer((request, response) => { routes.push(`PLAIN ${request.method} ${request.url}`); response.writeHead(200); response.end("{}"); });
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
