import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { text } from "node:stream/consumers";
import assert from "node:assert/strict";
import { parseJson } from "../../packages/oar/src/shared/json.js";

export const reset = 1_900_000_000;
export const providerError = { type: "usage_limit_reached", code: "usage_limit_reached", message: "You've hit your usage limit. Try again at 9:00 PM.", plan_type: "pro", resets_at: reset, limit_window_minutes: 300 };
export const rateHeaders = { "x-codex-primary-used-percent": "100", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-at": String(reset) };
export type Mode = "http-body" | "http-headers" | "sse-body" | "sse-headers" | "http400-body" | "http400-headers";
const sse = (type: string, data: unknown): string => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

interface Provider {
  state: { fail: boolean; exhausted: boolean };
  requests: { path: string | undefined; method: string | undefined; body: unknown; fail: boolean }[];
  port: number;
  close(): Promise<void>;
}

export async function provider(mode: Mode, initiallyFail: boolean): Promise<Provider> {
  const state = { fail: initiallyFail, exhausted: false };
  const requests: { path: string | undefined; method: string | undefined; body: unknown; fail: boolean }[] = [];
  async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await text(request);
    requests.push({ path: request.url, method: request.method, body: parseJson(body), fail: state.fail });
    if (request.url?.endsWith("/wham/usage") === true) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ plan_type: "pro", rate_limit: { allowed: !state.exhausted, limit_reached: state.exhausted,
        primary_window: { used_percent: state.exhausted ? 100 : 25, limit_window_seconds: 18_000, reset_after_seconds: 18_000, reset_at: state.exhausted ? reset : reset - 3600 }, secondary_window: null } }));
      return;
    }
    if (request.url?.endsWith("/responses") !== true) { response.writeHead(404); response.end("{}"); return; }
    if (state.fail) { state.exhausted = true; }
    if (mode.endsWith("headers")) {
      const headers = state.fail ? rateHeaders : { ...rateHeaders, "x-codex-primary-used-percent": "25", "x-codex-primary-reset-at": String(reset - 3600) };
      for (const [key, value] of Object.entries(headers)) { response.setHeader(key, value); }
    }
    if (state.fail && mode.startsWith("http")) {
      response.writeHead(mode.startsWith("http400") ? 400 : 429, { "content-type": "application/json" }); response.end(JSON.stringify({ error: providerError })); return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(sse("response.created", { type: "response.created", response: { id: "resp-quota-probe", object: "response", status: "in_progress", output: [] } }));
    if (state.fail) {
      response.end(sse("response.failed", { type: "response.failed", response: { id: "resp-quota-probe", object: "response", status: "failed", output: [], error: providerError } }));
    } else {
      response.end(sse("response.completed", { type: "response.completed", response: { id: "resp-quota-probe", object: "response", status: "completed", output: [
        { id: "message-seed", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Seed ready." }] },
      ], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }));
    }
  }
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try { await respond(request, response); }
    catch { response.writeHead(500); response.end("probe failure"); }
  }
  const server = createServer((request, response) => { void handle(request, response); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return { state, requests, port: address.port, async close(): Promise<void> {
    server.closeAllConnections();
    await server[Symbol.asyncDispose]();
  } };
}
