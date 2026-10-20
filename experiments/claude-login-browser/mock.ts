/** Local OAuth stand-in. Handles proxy requests itself and never forwards them. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Socket } from "node:net";

export const CODE = "oar-browser-probe-code-not-a-secret";
const TOKEN = "oar-browser-probe-access-not-a-secret";
const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const ORGANIZATION = "00000000-0000-4000-8000-000000000002";
const EMAIL = "browser-probe@example.invalid";

interface Authorization { state: string; challenge: string }
interface Observations { exchanges: number; profiles: number; verified: boolean; routes: string[] }
interface MockOAuth {
  url: string;
  seen: Observations;
  expect(value: Authorization): void;
  close(): Promise<void>;
}

export async function mockOAuth(key: Buffer, cert: Buffer): Promise<MockOAuth> {
  const seen: Observations = { exchanges: 0, profiles: 0, verified: false, routes: [] };
  let expected: Authorization | undefined = undefined;
  const sockets = new Set<Socket>();
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "https://api.anthropic.com");
    seen.routes.push(`${request.method ?? "GET"} ${url.pathname}`);
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    let result: unknown = undefined;
    let status = 200;
    if (url.pathname === "/v1/oauth/token" && request.method === "POST") {
      seen.exchanges += 1;
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.ok(typeof body === "object" && body !== null);
      assert.ok("code_verifier" in body && typeof body.code_verifier === "string");
      assert.ok("code" in body && body.code === CODE);
      assert.ok("state" in body && body.state === expected?.state);
      assert.equal(createHash("sha256").update(body.code_verifier).digest("base64url"), expected?.challenge);
      seen.verified = true;
      result = {
        access_token: TOKEN, refresh_token: "oar-browser-probe-refresh-not-a-secret",
        expires_in: 3600, token_type: "Bearer", scope: "user:profile user:inference user:sessions:claude_code",
        account: { uuid: ACCOUNT, email_address: EMAIL }, organization: { uuid: ORGANIZATION },
      };
    } else if (url.pathname === "/api/oauth/profile") {
      seen.profiles += 1;
      assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
      result = {
        account: { uuid: ACCOUNT, email: EMAIL, display_name: "Local login probe", created_at: "2026-01-01T00:00:00Z" },
        organization: {
          uuid: ORGANIZATION, organization_type: "claude_pro", rate_limit_tier: "default_claude_pro",
          has_extra_usage_enabled: false, billing_type: "stripe_subscription", subscription_created_at: "2026-01-01T00:00:00Z",
          cc_onboarding_flags: {},
        },
      };
    } else if (url.pathname === "/api/oauth/claude_cli/roles") {
      result = { organization_role: "user", workspace_role: "user", organization_name: "Local probe" };
    } else {
      status = 404;
      result = { error: "the local probe does not serve this route" };
    }
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  };
  const listener = (request: IncomingMessage, response: ServerResponse): void => {
    void (async (): Promise<void> => {
      try {
        await handle(request, response);
      } catch {
        // Never print the request body, which contains the synthetic code and PKCE verifier.
        response.writeHead(500);
        response.end("local OAuth assertion failed");
      }
    })();
  };
  const secure = createHttpsServer({ key, cert }, listener);
  const proxy = createServer(listener);
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => { sockets.delete(socket); });
  });
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
    url: `http://127.0.0.1:${String(address.port)}`,
    seen,
    expect(value: Authorization): void { expected = value; },
    async close(): Promise<void> {
      for (const socket of sockets) { socket.destroy(); }
      const closed = Promise.withResolvers<void>();
      proxy.close(() => { closed.resolve(); });
      await closed.promise;
      secure.close();
    },
  };
}
